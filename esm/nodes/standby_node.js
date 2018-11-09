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

        this.init();
    }

    async setInitialized(){
        await this.updateJsonZKData(this.zk_path, {initialized: true});
    }

    replenishSlaves(){
        let lastChildCount = null;

        const watchSlaveLocks = async () => {
            const slave_lock_path = `/lock/${this.zk_myid}`;
            const gc_reply = await this.zk.getChildren(slave_lock_path, true);

            if( gc_reply.children.length < ($config.pg_slave_count + 2)
                && (!lastChildCount || (gc_reply.children.length < lastChildCount))){
                //spin up a new process
                console.log(`Master (pid: ${this.pid}) will SPAWN a new process for ${slave_lock_path}`);
                var _node_path = path.join($config.app_deploy_path.replace(/~/g, process.env.HOME), 'current', 'cjs', 'nodes', 'standby_node.js');

                const cp = spawn('node', [`--inspect=0`, _node_path, `zk_parent_path=${this.zk_parent_path}`]);

                cp.stdout.on('data', _b => {console.log(_b.toString())});
                cp.stderr.on('data', _b => {console.log(_b.toString())});
            }

            lastChildCount = gc_reply.children.length;

            gc_reply.watch.then(watchSlaveLocks.bind(this));
        };
        watchSlaveLocks();
    }

    // async initPostgresMaster(){
    //     const pg_data_dir = path.join($config.pg_cluster_path, 'node0');
    //
    //     console.log(`Node (pid: ${this.pid}) PostgreSQL MASTER START with {port: ${($config.pg_port_start)}, data: ${pg_data_dir.replace(/~/g, process.env.HOME)}}`);
    //
    //     const cp = spawn(`/usr/lib/postgresql/9.4/bin/postgres`, [
    //         '-p', $config.pg_port_start,
    //         '-D', pg_data_dir.replace(/~/g, process.env.HOME)
    //     ]);
    //
    //     spawnSync(`createdb`, [
    //         '-p', $config.pg_port_start,
    //         '-U', this.user, $config.pg_database_name
    //     ]);
    //
    //     const pool = new pg.Pool({
    //         host: 'localhost',
    //         user: this.user,
    //         post: $config.pg_port_start,
    //         database: $config.pg_database_name
    //     });
    //
    //     cp.stderr.pipe(process.stderr);
    //     cp.stdout.pipe(process.stdout);
    //
    //     let g_reply = await this.zk.get(this.zk_path);
    //
    //     let conf = JSON.parse(g_reply.data);
    //     conf.pg_pid = cp.pid;
    //     await this.zk.set(this.zk_path, JSON.stringify(conf), g_reply.stat.version);
    //
    //     spawnSync(`/usr/lib/postgresql/9.4/bin/createdb`, [
    //         '-p', $config.pg_port_start,
    //         '-U', this.user,
    //         $config.pg_database_name
    //     ]);
    //
    //     spawnSync(`/usr/lib/postgresql/9.4/bin/pg_basebackup`, [
    //         '-p', $config.pg_port_start,
    //         '-D', $config.pg_master_basebackup_path.replace(/~/g, process.env.HOME)
    //     ]);
    //
    //     await new Promise((resolve, reject) => {
    //         pool.connect(async (err, client, done) => {
    //             if(err)
    //                 throw new Error(err);
    //
    //             await client.query(`
    //                 CREATE EXTENSION IF NOT EXISTS btree_gist;
    //                 CREATE EXTENSION IF NOT EXISTS bdr;
    //             `);
    //
    //             console.log(`Node (pid: ${this.pid}) attempting to create BDR group`);
    //             await client.query(`
    //                 SELECT bdr.bdr_group_create(
    //                   local_node_name := 'node${this.zk_myid}',
    //                   node_external_dsn := 'port=5598 dbname=${$config.pg_database_name} host=${this.host}'
    //             );`).then( _r => {return _r}, async (err) => {
    //
    //                 const pickRandomNode = () => {
    //                     const nodes_ar = Object.keys($config.nodes);
    //                     const myidx = nodes_ar.indexOf(this.zk_myid);
    //                     const attempt = (Math.random() * 10000) % nodes_ar.length;
    //                     if(myidx == attempt)
    //                         return pickRandomNode();
    //                     else{
    //                         return nodes_ar[attempt]; //return zookeeper myid;
    //                     }
    //                 };
    //
    //                 const otherNodeMyid = pickRandomNode();
    //
    //                 console.log(`Node (pid: ${this.pid}) BDR group creation failed, attempting to connect to another BDR-enabled node ${otherNodeMyid}`);
    //
    //                 await client.query(`
    //                     SELECT bdr.bdr_group_join(
    //                           local_node_name := 'node${otherNodeMyid}',
    //                           node_external_dsn := 'port=5598 dbname=${$config.pg_database_name} host=${this.host}',
    //                           join_using_dsn := 'port=5598 dbname=${$config.pg_database_name} host=${$config.nodes[otherNodeMyid]}'
    //                     );
    //                 `)
    //             });
    //
    //             await client.query(`SELECT bdr.bdr_node_join_wait_for_ready();`);
    //             console.log(`Node (pid: ${this.pid}) is up and ready to accept BDR traffic.`);
    //         });
    //     });
    //
    //     g_reply = await this.zk.get(this.zk_path);
    //
    //     conf = JSON.parse(g_reply.data);
    //     conf.db_init = true;
    //     await this.zk.set(this.zk_path, JSON.stringify(conf), g_reply.stat.version);
    // }

    // async initPostgresSlave(){
    //     //watchMaster for init
    //
    //
    //     console.log(`Node (pid: ${this.pid}) waiting for master to init DB...`);
    //     const watchMasterInit = async () => {
    //         const gc_reply = await this.zk.getChildren(`/lock/master/${this.zk_myid}`);
    //         const master_lock = gc_reply.children[0];
    //         const g_reply = await this.zk.get(`/lock/master/${this.zk_myid}/${master_lock}`);
    //         const lock_o = JSON.parse(g_reply.data);
    //
    //         const master_config_path = lock_o.config_path;
    //
    //         const mg_reply = await this.zk.get(master_config_path, true);
    //         const conf_o = JSON.parse(mg_reply.data);
    //
    //         if(!conf_o.db_init){
    //             return mg_reply.watch.then(watchMasterInit);
    //         }
    //     };
    //
    //     await watchMasterInit(); //blocks until master inits
    //     console.log(`Node (pid: ${this.pid}) received signal master (${master_config_path}) has initialized DB.`);
    //
    //     const pg_data_dir = `${$config.pg_cluster_path}/node${(this.slot_idx + 1)}`;
    //     await spawnSync(`cp`, ['-R', $config.pg_master_basebackup_path, pg_data_dir]);
    //
    //     await new Promise((resolve, reject) => {
    //         let ws = fs.createWriteStream(`${pg_data_dir}/postgresql.conf`);
    //         let rs = fs.createReadStream(path.join($config.app_deploy_path, 'current', 'remote_cfg', 'postgresql.slave.conf'), {autoClose: true});
    //         rs.pipe(ws);
    //         rs.on('end', resolve);
    //         rs.on('error', reject);
    //         ws.on('error', reject);
    //     });
    //
    //     const template = Handlebars.compile(fs.readFileSync(
    //         path.join($config.app_deploy_path, 'current', 'remote_cfg', 'recovery.slave.conf'),
    //         'utf8'), {noEscape: true});
    //
    //     fs.writeFileSync(`${pg_data_dir}/recovery.conf`, template({
    //         wal_archive_path: $config.pg_wal_archive_path,
    //         master_port: $config.pg_port_start,
    //         application_name: `slave${this.slot_idx}`
    //     }));
    //
    //
    //     const pg_port = $config.pg_port_start + 1 + this.slot_idx;
    //
    //     const cp = spawn(`/usr/lib/postgresql/9.4/bin/postgres`, [
    //         '-p', pg_port,
    //         '-D', pg_data_dir.replace(/~/g, process.env.HOME)
    //     ]);
    //
    //     const sg_reply = await this.zk.get(this.zk_path);
    //
    //     const s_conf = JSON.parse(g_reply.data);
    //     s_conf.db_init = true;
    //     await this.zk.set(this.zk_path, JSON.stringify(s_conf), g_reply.stat.version);
    // }

    async init(){
        await super.init();
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
                                console.log(`Node (PID: ${this.pid}) is in QUEUED state at position ${this.queue_pos}`);
                                this.updateProcName(`HashChain::Queued::${this.queue_pos}`);
                                break;
                            case 'granted':
                                this.queue_pos = null;
                                console.log(`Node (PID: ${this.pid}) has been GRANTED a lock for slot ${_o.slot_idx}`);
                                this.slot_idx = _o.slot_idx;

                                if(this.slot_idx == 0){
                                    this.is_master = true;
                                    console.log(`Node (PID: ${this.pid}) has the MASTER lock`);
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
                if(!this.is_master){
                    //await this.initPostgresSlave();
                }
            }).then(async () => {
                await this.setInitialized();
            });
        });
    }
}

new StandbyNode();
