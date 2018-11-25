import express from "express";
import * as $package from "../package.json";
import * as fs from "fs";
import * as path from "path";
import {Pool} from "pg";
import {spawnSync} from "child_process";
import yaml from "js-yaml";
import ZooKeeper from "zk";

class PghcAPI {
    constructor() {
        this.app = express();
        this.port = 8080;

        this.version = $package.version;

        //get hostname from OS
        this.hostname = process.env.HOSTNAME;

        //get pod idx
        const hostname_components = this.hostname.split('-');
        this.pod_idx = parseInt(hostname_components[hostname_components.length - 1]);

        const pgReplSet = yaml.safeLoad(fs.readFileSync(path.join(__dirname, '..', 'kubernetes', 'controllers', 'pghc-postgres-repl.statefulset.spec.k8s.yaml')));
        const bkReplSet = yaml.safeLoad(fs.readFileSync(path.join(__dirname, '..', 'kubernetes', 'controllers', 'pghc-backend.statefulset.spec.k8s.yaml')));

        //Find the correct read and write database to connect to via simple math.
        this.bkClusterIdx = parseInt(this.pod_idx / parseInt(bkReplSet.spec.replicas / $package.pghc.num_bdr_groups));
        this.bkClusterInnerIdx = (this.pod_idx % parseInt(bkReplSet.spec.replicas / $package.pghc.num_bdr_groups));
        this.pgMasterIdx = this.bkClusterIdx * parseInt( pgReplSet.spec.replicas / $package.pghc.num_bdr_groups );
        this.pgSlaveIdx = this.pgMasterIdx + 1 + this.bkClusterInnerIdx;

        this.rconn = null;
        this.wconn = null;
    }

    //init zookeeper connection
    async initZookeeper () {
        const zkServer = `pghc-zookeeper-${this.bkClusterIdx}.pghc-zookeeper-dns.pghc.svc.cluster.local:2181`;
        console.log(`Connecting to ZooKeeper server at ${zkServer}...`);

        this.zk = new ZooKeeper({
            connect: zkServer,
            timeout: 20000,
        });

        const tryZkConnect = async () => {
            setTimeout(() => {
                if(this.zk.client_id == 0){
                    console.error(`TERMINATING: Could not connect to zookeeper (timeout)`);
                    process.exit(1);
                }
            }, 30000);

            await this.zk.connect();
        };

        await tryZkConnect();

        //heartbeat
        setInterval(async () => {
            await this.zk.get('/chain').catch((_e) => {
                console.error(_e);
                process.exit(1);
            });
        }, 1000);

        return this.zk;
    }

    async initDatabase() {

        console.log(`Connecting to read DB ${this.pgSlaveIdx}; write DB ${this.pgMasterIdx}`);

        const getConnection = async (connHost) => {
            return new Promise(async (_res, _rej) => {
                const pool = new Pool({
                    host: connHost,
                    user: 'app',
                    port: 5432,
                    database: 'hash_chain'
                });

                pool.connect((err, client, done) => {
                    if(err){
                        return _rej(err);
                    }else{
                        _res({client, done});
                    }
                });
            });
        };

        this.rconn = await getConnection(`pghc-postgres-repl-${this.pgSlaveIdx}.pghc-postgres-dns.pghc.svc.cluster.local`).catch(_e => {
            throw new Error(_e);
        });

        this.wconn = await getConnection(`pghc-postgres-repl-${this.pgMasterIdx}.pghc-postgres-dns.pghc.svc.cluster.local`).catch(_e => {
            throw new Error(_e);
        });
    };

    async zkMkdirp(_path, data) {
        const path_ar = _path.substr(1).split('/');
        const path_constructed_ar = [];
        while(path_ar.length > 0){
            path_constructed_ar.push(path_ar.shift());
            let insert_data = undefined;
            if(path_ar.length == 0){
                insert_data = data; //insert data on the last iteration
            }
            await this.zk.create(`/${path.join.apply(this, path_constructed_ar)}`, insert_data).then(_p => {return _p}, (err) => {
                if(err.name != 'ZNODEEXISTS'){
                    throw new Error(err);
                }
            })
        }
    }

    async start() {
        await this.initDatabase();
        await this.initZookeeper();

        this.zkMkdirp("/chain");

        console.log("Database connections INIT... Starting API server...");
        this.app.listen(this.port, () => {

            console.log(`HashChain API (v${$package.version}) LISTENING ${this.port}`);

            this.app.get('/ping', (req, res, next) => {
                res.send("pong");
            });

            this.app.get('/reload_schema', async (req, res) => {
                await this.wconn.client.query(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'sql', 'schema.sql'), 'utf8')).catch(_e => {
                    res.status(500).send(_e.toString());
                });

                res.status(200).send('OK');
            });

            this.app.post('/chain', async (req, res) => {

                //queue for the lock
                const lockpath = await this.zk.create('/chain/lock.', new String(), ZooKeeper.ZOO_EPHEMERAL | ZooKeeper.ZOO_SEQUENCE ).catch(_e => {
                    throw new Error(_e);
                });

                const dbWrite = async (sqId) => {

                    console.log(`Writing new link with sequence number ${sqId}`);

                    const resultSet = await this.wconn.client.query(`
                        BEGIN;
                            LOCK TABLE chain IN EXCLUSIVE MODE;
                            SELECT * FROM pghc_add_link(${sqId}, '${this.hostname}');
                        COMMIT;
                    `).catch(_e => {
                        throw new Error(_e);
                    });

                    const tryDel = async () => {
                        const g_reply = await this.zk.get(lockpath).catch(_e => {
                            throw new Error(_e);
                        });

                        return this.zk.delete(lockpath, g_reply.stat.version).catch(_e => {
                            if(_e.name == 'ZBADVERSION'){
                                return tryDel();
                            }else{
                                throw new Error(_e);
                            }
                        });
                    };

                    await tryDel();
                    return resultSet[2].rows[0];
                };

                const checkLockStatus = async () => {
                    return this.zk.getChildren('/chain').then(async _r => {
                        const sortedChildren = _r.children.sort();
                        const lidx = sortedChildren.indexOf(path.basename(lockpath));
                        if(lidx == 0){
                            //get lock sequence number
                            const sqId = parseInt(path.basename(lockpath).split('.')[1]);
                            const newLink = await dbWrite(sqId);
                            res.json(newLink);
                            return newLink;
                        }else{
                            const prevChild = sortedChildren[lidx - 1];
                            const e_reply = await this.zk.exists(`/chain/${prevChild}`, true);

                            if(!e_reply.stat){
                                return checkLockStatus();
                            }else{
                                return e_reply.watch.then(checkLockStatus.bind(this));
                            }

                        }
                    }).catch(_e => {
                        res.status(500).send(_e.toString());
                        throw new Error(_e);
                    });
                };

                await checkLockStatus();
            });

            this.app.get('/chain/recent', async (req, res) => {
                const _r = await this.rconn.client.query(`
                    SELECT * FROM chain
                    GROUP BY chain.zk_id
                    ORDER BY chain.zk_id DESC 
                    LIMIT 10;
                `);

                res.json(_r.rows);
            });

        });
    }
}

const api = new PghcAPI();
api.start();