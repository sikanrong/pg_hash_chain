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

    //Install all necessary linux software
    shipit.blTask('install-apt-packages', async () => {
        await shipit.remote("sudo apt install -y "+$config.apt_preinstall_dependencies.join(" "));
        await shipit.remote("sudo sh -c \"echo '"+$config.apt_repositories.join("\n")+"' > /etc/apt/sources.list.d/cluster.repos.list\"");

        for (const key in $config.apt_keys){
            $config.apt_keys[key];
            await shipit.remote("mkdir -p ~/apt_keys");
            await shipit.remote(`curl ${$config.apt_keys[key]} > ~/apt_keys/${key}.asc`);
        }
        await shipit.remote("sudo apt-key add ~/apt_keys/*.asc");
        await shipit.remote("sudo apt-get update");
        await shipit.remote(`sudo apt install -y ${$config.apt_dependencies.join(" ")}`);
    });

    shipit.blTask('configure-environment', async () => {
        const template = Handlebars.compile(fs.readFileSync("./remote_cfg/bash_profile.sh", "utf8"), {noEscape: true});
        fs.writeFileSync("./tmp/bash_profile.sh", template({
            env_path: $config.env_path.join(':')
        }));
        await shipit.copyToRemote('./tmp/bash_profile.sh', '~/.profile');
        await shipit.remote("source ~/.profile");
    });

    //Configure zookeeper so that we can hand off the rest of configuration to it
    shipit.blTask('configure-zookeeper', async () => {
        await shipit.remote(`cp -R /etc/zookeeper/conf_example ${$config.zk_config_path}`);
        await shipit.local(Object.keys($config.nodes).map(myid => {
            return `ssh ${$config.nodes[myid].user}@${$config.nodes[myid].host} 'echo ${myid} > ${$config.zk_config_path}/myid'`
        }).join(" && "));
        var conf = fs.readFileSync("remote_cfg/zoo.cfg", "utf8");
        var template = Handlebars.compile(conf, {noEscape: true});

        var zk_servers = Object.keys($config.nodes).map(myid => {
           return `server.${myid}\=${$config.nodes[myid].host}:${$config.zk_discovery_port}:${$config.zk_election_port}`
        }).join("\n");

        fs.writeFileSync("./tmp/zoo.cfg", template({
            zk_servers: zk_servers,
            zk_datadir: $config.zk_datadir,
            zk_client_port: $config.zk_client_port
        }));

        await shipit.copyToRemote('./tmp/zoo.cfg', `${$config.zk_config_path}/zoo.cfg`);
        await shipit.remote(
           `sudo rm /etc/zookeeper/conf;
            sudo ln -s ${$config.zk_config_path} /etc/zookeeper/conf;
            sudo service zookeeper restart;`
        , true);
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
    
    shipit.blTask('configure-postgres', async () => {

        const slave_indices = Array.from(Array($config.pg_slave_count).keys());

        const configureSlaves = async ()=>{
            const cSlave = async _io=>{
                const _i = _io + 1;

                await shipit.remote(`mkdir -p ${$config.pg_cluster_path}/node${_i}`);

                //slave postgresql.conf doesn't really have any config-dependent data in it.
                await shipit.copyToRemote('./remote_cfg/postgresql.slave.conf', `${$config.pg_cluster_path}/node${_i}/postgresql.conf`);

                const template = Handlebars.compile(fs.readFileSync('./remote_cfg/recovery.slave.conf', 'utf8'), {noEscape: true});
                fs.writeFileSync(`./tmp/recovery.slave${_i}.conf`, template({
                    wal_archive_path: $config.pg_wal_archive_path,
                    master_port: $config.pg_port_start,
                    application_name: `slave${_i}`
                }));

                await shipit.copyToRemote(`./tmp/recovery.slave${_i}.conf`, `${$config.pg_cluster_path}/node${_i}/recovery.conf`);
                await shipit.copyToRemote(`./tmp/pg_hba.conf`, `${$config.pg_cluster_path}/node${_i}/pg_hba.conf`);

                await shipit.remote(`chmod -R 700 ${$config.pg_cluster_path}/node${_i}`);
            };

            await Promise.all(slave_indices.map(_i => {
                return cSlave(_i);
            }));
        };

        await shipit.remote(`
            source ~/.profile;
            rm -rf ${$config.pg_master_basebackup_path};
            rm -rf ${$config.pg_wal_archive_path};
            rm -rf ${$config.pg_cluster_path};
            mkdir -p ${$config.pg_cluster_path};
            mkdir -p ${$config.pg_wal_archive_path};
            chmod -R 777 ${$config.pg_cluster_path};
            
            sudo useradd -m bdr || echo "user not created";
            sudo useradd -m bdrro || echo "user not created";
            
            sudo chmod -R 777 /var/run/postgresql;
            
            initdb -D ${$config.pg_cluster_path}/node0 -A trust -U app;
        `);

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

        const ssnames = slave_indices.map(_i => {
            return `slave${_i}`
        });

        const template = Handlebars.compile(fs.readFileSync('./remote_cfg/postgresql.master.conf', 'utf8'), {noEscape: true});
        fs.writeFileSync("./tmp/postgresql.master.conf", template({
            wal_archive_path: $config.pg_wal_archive_path,
            synchronous_standby_names: ssnames.join(', ')
        }));

        await shipit.copyToRemote("./tmp/postgresql.master.conf", `${$config.pg_cluster_path}/node0/postgresql.conf`);
        await shipit.copyToRemote("./tmp/pg_hba.conf", `${$config.pg_cluster_path}/node0/pg_hba.conf`);

        await configureSlaves();
    } );

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
                'configure-environment',
                'install-apt-packages',
                'configure-zookeeper',
                'configure-postgres'
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