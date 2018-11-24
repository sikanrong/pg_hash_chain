import express from "express";
import * as $package from "../package.json";
import * as fs from "fs";
import * as path from "path";
import {Pool} from "pg";
import {spawnSync} from "child_process";
import yaml from "js-yaml";

const app = express();
const port = 8080;

const version = $package.version;

//get hostname from OS
const hostname = process.env.HOSTNAME;

//get pod idx
const hostname_components = hostname.split('-');
const backend_pod_idx = parseInt(hostname_components[hostname_components.length - 1]);

const pgReplSet = yaml.safeLoad(fs.readFileSync(path.join(__dirname, '..', 'kubernetes', 'controllers', 'pghc-postgres-repl.statefulset.spec.k8s.yaml')));
const bkReplSet = yaml.safeLoad(fs.readFileSync(path.join(__dirname, '..', 'kubernetes', 'controllers', 'pghc-backend.statefulset.spec.k8s.yaml')));

//Find the correct read and write database to connect to via simple math.
const bkClusterIdx = parseInt(backend_pod_idx / parseInt(bkReplSet.spec.replicas / $package.pghc.num_bdr_groups));
const bkClusterInnerIdx = (backend_pod_idx % parseInt(bkReplSet.spec.replicas / $package.pghc.num_bdr_groups));
const pgMasterIdx = bkClusterIdx * parseInt( pgReplSet.spec.replicas / $package.pghc.num_bdr_groups );
const pgSlaveIdx = pgMasterIdx + 1 + bkClusterInnerIdx;

let rconn, wconn;

const initDatabase = async () => {

    console.log(`Connecting to read DB ${pgSlaveIdx}; write DB ${pgMasterIdx}`);

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

    rconn = await getConnection(`pghc-postgres-repl-${pgSlaveIdx}.pghc-postgres-dns.pghc.svc.cluster.local`).catch(_e => {
        throw new Error(_e);
    });

    wconn = await getConnection(`pghc-postgres-repl-${pgMasterIdx}.pghc-postgres-dns.pghc.svc.cluster.local`).catch(_e => {
        throw new Error(_e);
    });
};

initDatabase().then(function () {
    console.log("Database connections INIT... Starting API server...");
    app.listen(port, () => {

        console.log(`HashChain API (v${$package.version}) LISTENING ${port}`);

        app.get('/ping', (req, res, next) => {
            res.send("pong");
        });

        app.get('/reload_schema', async (req, res) => {
            await wconn.client.query(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'sql', 'schema.sql'), 'utf8')).catch(_e => {
                res.status(500).send(_e.toString());
            });

            res.status(200).send('OK');
        });
    });
}, _e => {
    throw new Error(_e);
});