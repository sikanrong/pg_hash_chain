import * as fs from "fs";
import * as path from "path";
import Handlebars from "handlebars";
import ZooKeeper from "zk";
import * as $config from "../../cluster";
import Node from "./node";
import {spawn, exec, spawnSync} from "child_process";
import * as pg from "pg";

class StandbyNode extends Node{
    constructor(){
        super();

        this.is_master = false;
        this.slot_idx = null;
        this.queue_pos = null;
        this.lock_path = null;
        this.pg_pid = null;
        this.pg_proc = null;
        this.pg_cleanup = null;

        this.init();
    }

    async setInitialized(){
        this.log("sending INIT signal");
        await this.updateJsonZKData(this.zk_path, {initialized: true});
    }

    replenishSlaves(){
        let lastChildCount = null;

        const watchSlaveLocks = async () => {
            const slave_lock_path = `/lock/${this.zk_myid}`;
            const gc_reply = await this.zk.getChildren(slave_lock_path, true);

            if( gc_reply.children.length < ($config.pg_slave_count + 2)
                && (!lastChildCount || (gc_reply.children.length < lastChildCount))){

                const howMany = ($config.pg_slave_count + 2) - gc_reply.children.length;

                for(var i = 0; i < howMany; i++){
                    //spin up a new process
                    this.log(`MASTER will SPAWN a new process for ${slave_lock_path}`);
                    var _node_path = path.join($config.app_deploy_path.replace(/~/g, process.env.HOME), 'current', 'cjs', 'nodes', 'standby_node.js');

                    const cp = spawn('node', [`--inspect=0`, _node_path, `zk_parent_path=${this.zk_parent_path}`]);

                    cp.stdout.on('data', _d => {console.log(_d.toString())});
                    cp.stderr.on('data', _d => {console.log(_d.toString())});
                }
            }

            lastChildCount = gc_reply.children.length;

            gc_reply.watch.then(watchSlaveLocks.bind(this));
        };
        watchSlaveLocks();
    }

    async startPostgres(pg_data_dir, port){
        const cp = spawn(`/usr/lib/postgresql/9.4/bin/postgres`, [
            '-p', port,
            '-D', pg_data_dir.replace(/~/g, process.env.HOME)
        ]);

        this.pg_pid = cp.pid;

        cp.stdout.on('data', this.log.bind(this));
        cp.stderr.on('data', this.log.bind(this));

        await this.updateJsonZKData(this.zk_path, {pg_pid: this.pg_pid});
        this.pg_proc = cp;
        return cp;
    }

    async initPostgresMaster(){
        const pg_data_dir = path.join($config.pg_cluster_path, 'node0');

        await this.startPostgres(pg_data_dir, $config.pg_port_start);

        spawnSync('rm', ['-rf', $config.pg_master_basebackup_path.replace(/~/g, process.env.HOME)]);
        spawnSync('mkdir', ['-p', $config.pg_master_basebackup_path.replace(/~/g, process.env.HOME)]);

        let attemptBaseBackup = async (retries) => {
            const _out = spawnSync(`/usr/lib/postgresql/9.4/bin/pg_basebackup`, [
                '-p', $config.pg_port_start,
                '-D', $config.pg_master_basebackup_path.replace(/~/g, process.env.HOME)
            ]);

            if(_out.status == 0){
                this.log(_out.stdout.toString());
                this.log(_out.stderr.toString());
            }else if(retries <= 0){
                const _e = new Error(_out.stderr.toString());
                this.logError(_e.toString());
                throw(_e);
            }else{
                this.log(`Node (PID: ${this.pid}) MASTER retrying pg_basebackup. Retries remaining: ${retries}`);
                const _e = new Error(_out.stderr.toString());

                await new Promise((resolve, reject) => {
                    setTimeout(() => {
                        resolve(attemptBaseBackup(retries-1));
                    }, 1000);

                });
            }
        };

        await attemptBaseBackup(5);

        await this.updateJsonZKData(this.zk_path, {pg_basebackup_done: true});


        await new Promise((resolve, reject) => {
            new pg.Pool({
                host: '127.0.0.1',
                user: this.user,
                port: $config.pg_port_start,
                database: 'postgres'
            }).connect((err, client, done) => {
                this.pg_cleanup = done;

                if(err){
                    return reject(err);
                }

                this.log(`MASTER attempt create database ${$config.pg_database_name}`);
                Promise.all([
                    client.query(`CREATE DATABASE ${this.user} TEMPLATE template0`),
                    client.query(`CREATE DATABASE ${$config.pg_database_name} TEMPLATE template0`)
                ]).then(()=>{
                    done();
                    this.log(`MASTER create database ${$config.pg_database_name} successful`);
                    resolve();
                }, (_e) => {
                    //Don't reject if database is not created
                    this.log(`(caught) ${_e}`);
                    done();
                    resolve();
                });

            });
        }).catch(_e => {
            throw new Error(_e);
        });

        const pool = new pg.Pool({
            host: '127.0.0.1',
            user: this.user,
            port: $config.pg_port_start,
            database: $config.pg_database_name
        });

        await new Promise((resolve, reject) => {
            pool.connect((err, client, done) => {
                this.pg_cleanup = done;

                if(err){
                    return reject(err);
                }

                new Promise(async (_res, _rej) => {
                    this.log(`MASTER attempting to create BDR extensions`);

                    await new Promise(async (__res, __rej) => { //these param names are getting out of hand...
                        let tryCreateExt = async () => {
                            client.query(`
                                DO $$
                                BEGIN
                                    IF EXISTS (
                                        SELECT schema_name
                                          FROM information_schema.schemata
                                          WHERE schema_name = 'bdr'
                                    )
                                    THEN
                                      EXECUTE 'SELECT bdr.remove_bdr_from_local_node(TRUE)';
                                      DROP EXTENSION bdr;
                                    END IF;
                                END
                                $$
                            `).then(() => {
                                return client.query(`
                                    CREATE EXTENSION IF NOT EXISTS btree_gist;
                                    CREATE EXTENSION bdr;
                                `)
                            }).then(() => {
                                this.log(`MASTER create BDR extensions success`);
                                __res();
                            }).catch(_e => {
                                if(_e.code == 55000){
                                    this.log(`(caught) ${_e}`);
                                    this.log(`MASTER retry create BDR extensions`);
                                    setTimeout(tryCreateExt, 500);
                                }else{
                                    __rej(_e);
                                }
                            });
                        };

                        await tryCreateExt();
                    }).catch(_e => {
                        throw new Error(_e);
                    });

                    let deploy_id = path.basename(this.zk_parent_path);
                    let bdr_lock_path = `/lock/bdr/${deploy_id}`;

                    //master-only lock to figure out which node initially creates the BDR group and who joins it (and which
                    //nodes are available to join.)
                    await this.zkMkdirp(bdr_lock_path);

                    let bdrConsensus = async () => {
                        this.master_bdr_lock = await this.zk.create(
                            `${bdr_lock_path}/bdr.`,
                            this.zk_myid.toString(),
                            (ZooKeeper.ZOO_SEQUENCE | ZooKeeper.ZOO_EPHEMERAL)
                        );

                        let gc_reply = await this.zk.getChildren(bdr_lock_path).catch(_e => {
                            throw new Error(_e);
                        });

                        if(gc_reply.children.indexOf(path.basename(this.master_bdr_lock)) == 0){
                            this.log(`MASTER (${this.host}) BDR GROUP CREATE`);
                            await client.query(`
                                SELECT bdr.bdr_group_create(
                                  local_node_name := 'node${this.zk_myid}',
                                  node_external_dsn := 'port=5598 dbname=${$config.pg_database_name} host=${this.host}'
                            );`).then(() => {
                                this.log("MASTER BDR GROUP CREATE success");
                            }).catch(_e => {
                                throw new Error(_e);
                            });
                        }else{
                            const g_reply = await this.zk.get(path.join(bdr_lock_path, gc_reply.children[0])).catch(_e => {
                                throw new Error(_e);
                            });

                            const otherNodeMyid = g_reply.data.toString();
                            const otherNodeHost = $config.nodes[otherNodeMyid].host;
                            this.log(`MASTER BDR GROUP JOIN other node at ${otherNodeHost}`);

                            await client.query(`
                                SELECT bdr.bdr_group_join(
                                      local_node_name := 'node${this.zk_myid}',
                                      node_external_dsn := 'port=5598 dbname=${$config.pg_database_name} host=${this.host}',
                                      join_using_dsn := 'port=5598 dbname=${$config.pg_database_name} host=${otherNodeHost}'
                                );
                            `).then(() => {
                                this.log(`MASTER BDR GROUP JOIN success. Joined BDR group via node at ${otherNodeHost}`);
                            }).catch(_e => {
                                throw new Error(_e);
                            });
                        }
                    };

                    await bdrConsensus().catch(_e => {
                        throw new Error(_e);
                    });

                    this.log(`MASTER waiting for BDR ready signal`);

                    await client.query(`SELECT bdr.bdr_node_join_wait_for_ready();`).then(() => {
                        done();
                        _res();
                    }, _rej);

                }).then(resolve, reject);
            });
        }).catch(_e => {
            throw new Error(_e);
        });

        this.log(`MASTER is up and ready to accept BDR traffic.`);

        await this.updateJsonZKData(this.zk_path, {pg_init: true});
    }

    async initPostgresSlave(){
        //watchMaster for init

        this.log(`SLAVE waiting for MASTER to basebackup...`);
        const watchBaseBackup = async () => {
            await new Promise(async (resolve, reject) => {
                let doWatch = async () => {
                    this.log(`SLAVE watching for MASTER basebackup...`);
                    const gc_reply = await this.zk.get(`/lock/${this.zk_myid}`, true).then(_r => {return _r}, _e => {
                        this.log(_e);
                        doWatch();
                    });;

                    const master_lock = JSON.parse(gc_reply.data)[0];
                    if(!master_lock){
                        return doWatch();
                    }

                    const g_reply = await this.zk.get(`/lock/${this.zk_myid}/${master_lock}`, true).then(_r => {return _r}, _e => {
                        this.log(_e);
                        doWatch();
                    });

                    const lock_o = JSON.parse(g_reply.data);

                    const master_config_path = lock_o.config_path;

                    const mg_reply = await this.zk.get(master_config_path, true);
                    const conf_o = JSON.parse(mg_reply.data);
                    this.log(`SLAVE reporting MASTER (${master_config_path}) data: ${mg_reply.data.toString()}`);

                    if(!conf_o.pg_basebackup_done){
                        mg_reply.watch.then(doWatch);
                        g_reply.watch.then(doWatch);
                        gc_reply.watch.then(doWatch);
                    }else{
                        this.log(`received signal master (${master_config_path}) has executed basebackup`);
                        resolve();
                    }
                };

                doWatch();
            });
        };

        await watchBaseBackup(); //blocks until master inits

        const pg_data_dir = `${$config.pg_cluster_path}/node${(this.slot_idx)}`;

        //copy the basebackup but preserve the existing configs.
        const _out = spawnSync(`cp`, ['-nR', path.join($config.pg_master_basebackup_path, '*'), pg_data_dir], {shell: true});
        if(_out.status == 0){
            this.log(_out.stdout.toString());
            this.log(_out.stderr.toString());
        }else{
            this.logError(_out.stderr.toString());
            throw new Error(_out.stderr.toString())
        }

        const pg_port = $config.pg_port_start + 1 + this.slot_idx;

        await this.startPostgres(pg_data_dir, pg_port);

        await this.updateJsonZKData(this.zk_path, {pg_init: true});
    }

    async init(){
        await super.init();

        function exitHandler(options, exitCode) {
            if(this.pg_cleanup){
                //should terminate any postgres connections on exit.
                this.pg_cleanup();
            }
            if(this.pg_proc){
                this.pg_proc.kill();
            }
        }

        //do something when app is closing
        process.on('exit', exitHandler.bind(this));

        //catches ctrl+c event
        process.on('SIGINT', exitHandler.bind(this));

        // catches "kill pid" (for example: nodemon restart)
        process.on('SIGUSR1', exitHandler.bind(this));
        process.on('SIGUSR2', exitHandler.bind(this));

        await this.zk.connect().then(() => {
            return this.zk.create(
                path.join(this.zk_parent_path, 'subnode.'),
                JSON.stringify({
                    initialized: false,
                    pid: this.pid,
                    pg_pid: null,
                    host: this.host,
                    user: this.user
                }),
                ZooKeeper.ZOO_EPHEMERAL | ZooKeeper.ZOO_SEQUENCE
            ).then(async _path => {
                this.zk_path = _path;

                await new Promise((resolve, reject) => {
                    this.lockSlot().subscribe(_o => {
                        switch(_o.message){
                            case 'lockfile_created':
                                this.lock_path = _o.lockfile;
                                break;
                            case 'queued':
                                this.queue_pos = (_o.lock_idx - $config.pg_slave_count);
                                this.log(`is in QUEUED state at position ${this.queue_pos}`);
                                this.updateProcName(`HashChain::Queued::${this.queue_pos}`);
                                break;
                            case 'granted':
                                this.queue_pos = null;
                                this.log(`has been GRANTED a lock for slot ${_o.slot_idx}`);
                                this.slot_idx = _o.slot_idx;

                                if(this.slot_idx == 0){
                                    this.is_master = true;
                                    this.log(`has the MASTER lock`);
                                    this.updateProcName(`HashChain::Master::${_o.slot_idx}`);
                                    this.replenishSlaves();
                                }else{
                                    this.updateProcName(`HashChain::Slave::${_o.slot_idx}`);
                                }

                                resolve(this.slot_idx);
                                break;

                        }
                    });
                });
            }).then(()=>{
                //start Apoptosis monitor
                this.apoptosisMonitor();
                return;
            }).then(async ()=>{
                if(this.is_master){
                    await this.initPostgresMaster();
                }else{
                    await this.initPostgresSlave();
                }
            }).then(async () => {
                await this.setInitialized();
            });
        });
    }
}

new StandbyNode();
