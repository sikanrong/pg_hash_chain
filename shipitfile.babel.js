import * as fs from "fs";
import * as path from "path";
import * as $config from "./cluster.json";
import Handlebars from "handlebars";
import ZooKeeper from "zk";
import q from "q";
import {exec, spawn, spawnSync} from 'child_process';
import OrchestratorNode from "./esm/nodes/orchestrator_node";

export default shipit => {
    require('shipit-deploy')(shipit);

    shipit.initConfig({
        default: {
            ignores: ['.git', 'node_modules'],
            keepReleases: 2,
            deleteOnRollback: false,
            key: $config.ssh_key,
            shallowClone: true,
            deployTo: $config.app_deploy_path,
            servers: Object.keys($config.nodes).map(node_id => {
                let node = $config.nodes[node_id];
                return {
                    host: node.host,
                    user: node.user
                }
            })
        },

        development: {
            workspace: "./",
            dirToCopy: ".",
            shallowClone: false
        },

        production: {
            workspace: $config.shipit_workspace,
            repositoryUrl: $config.app_deploy_from,
            branch: $config.app_deploy_from_branch
        },
    });



    shipit.on('init', async () => {
        await shipit.local("mkdir -p ./tmp");
    });

    shipit.blTask('install_npm_packages', async () => {
        await shipit.remote(
            `cd ${$config.app_deploy_path}/current; 
            npm install;`
        );
    });

    shipit.blTask('docker-build', async () => {

        //Write PostgreSQL configuration files to tmp directory for COPY by docker.
        fs.writeFileSync(`./tmp/pg_hba.conf`,
            `${Object.keys($config.nodes).map(myid => {
                return `
                  host all all ${$config.nodes[myid].host}/32 trust
                  host replication all ${$config.nodes[myid].host}/32 trust
              `;
            }).join("\n")}
              host all all ::1/128 trust
              host all all 127.0.0.1/32 trust
              host all all localhost trust
              host replication all ::1/128 trust
              local all all trust
              local replication all trust
          `);

        const slave_indices = Array.from(Array($config.pg_slave_count).keys());

        const ssnames = slave_indices.map(_i => {
            return `slave${_i+1}`
        });

        //Write PostgreSQL master node configuration file.
        let template = Handlebars.compile(fs.readFileSync('./remote_cfg/postgresql.master.conf', 'utf8'), {noEscape: true});
        fs.writeFileSync("./tmp/postgresql.master.conf", template({
            wal_archive_path: $config.pg_wal_archive_path,
            synchronous_standby_names: ssnames.join(', ')
        }));

        //Write PostgreSQL WAL-replica (slave) node configuration files.
        slave_indices.forEach(_i => {
            const template = Handlebars.compile(fs.readFileSync('./remote_cfg/recovery.slave.conf', 'utf8'), {noEscape: true});
            fs.writeFileSync(`./tmp/recovery.slave${_i}.conf`, template({
                wal_archive_path: $config.pg_wal_archive_path,
                master_port: $config.pg_port_start,
                application_name: `slave${_i}`
            }));
        });

        //Write Zookeeper configuration files
        const conf = fs.readFileSync("remote_cfg/zoo.cfg", "utf8");
        template = Handlebars.compile(conf, {noEscape: true});

        const zk_servers = Object.keys($config.nodes).map(myid => {
            return `server.${myid}\=${$config.nodes[myid].host}:${$config.zk_discovery_port}:${$config.zk_election_port}`
        }).join("\n");

        fs.writeFileSync("./tmp/zoo.cfg", template({
            zk_servers: zk_servers,
            zk_datadir: $config.zk_datadir,
            zk_client_port: $config.zk_client_port
        }));

        await shipit.local(`
            sudo -u sikanrong docker build -t pghc_node .
        `);
    });

    shipit.task('remote_zk_configure', async () => {
        const _n = new OrchestratorNode((deploy_path)=>{
            for(let i = 0; i < ($config.pg_slave_count + 1); i++){
                shipit.remote(`nohup node --inspect=${$config.app_debug_port_start + i} ${$config.app_deploy_path}/current/cjs/nodes/standby_node.js zk_parent_path=${deploy_path} &`);
            }
        });

        return _n.init_promise;
    });

    shipit.blTask('build-esm', async () => {
        await shipit.remote(`
            cd ${$config.app_deploy_path}/current;
            npm run build;
        `);
    });

    shipit.on('deploy', async () => {
        if(shipit.environment == 'development'){
            shipit.blTask("deploy:fetch", async ()=>{
                shipit.workspace = shipit.config.workspace;
            });
        }
    });


    shipit.on('deployed', async () => {
        return shipit.start([
            'build-esm'
        ]);
    });

    shipit.task('build', async () => {
        shipit.on('deploy', async () => {
            return shipit.start([
                //'docker_pull'
            ]);
        });

        shipit.on('deployed', async () => {
            return shipit.start([
                'install_npm_packages',
                'remote_zk_configure'
            ]);
        });

        shipit.start('deploy');
    });
}