import * as fs from "fs";
import * as $config from "./cluster.json";
import Handlebars from "handlebars";
import ZooKeeper from "zk";
import * as path from "path";

export default shipit => {
    require('shipit-deploy')(shipit);

    shipit.initConfig({
        default: {
            workspace: $config.shipit_workspace,
            deployTo: $config.app_deploy_path,
            repositoryUrl: $config.app_deploy_from,
            ignores: ['.git', 'node_modules'],
            keepReleases: 2,
            deleteOnRollback: false,
            key: $config.ssh_key,
            shallowClone: true,
        },

        production: {
            servers: $config.nodes.map(node => {
                return {
                    host: node.host,
                    user: node.user
                }
            })
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
        await shipit.local($config.nodes.map(node => {
            return `ssh ${node.user}@${node.host} 'echo ${node.myid} > ${$config.zk_config_path}/myid'`
        }).join(" && "));
        var conf = fs.readFileSync("remote_cfg/zoo.cfg", "utf8");
        var template = Handlebars.compile(conf, {noEscape: true});

        var zk_servers = $config.nodes.map(node => {
           return `server.${node.myid}\=${node.host}:${$config.zk_discovery_port}:${$config.zk_election_port}`
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

    shipit.on('deploy', async () => {
        return shipit.start([
            'configure-environment',
            'install-apt-packages',
            'configure-zookeeper'
        ]);
    });

    shipit.blTask('install-npm-packages', async () => {
        await shipit.remote(
            `cd ${$config.app_deploy_path}/current; 
            npm install;`
        );
    });

    shipit.task('remote_zk_configure', async () => {
        const zk = new ZooKeeper({
            connect: `${$config.nodes[0].host}:${$config.zk_client_port}`,
            timeout: 20000,
            debug_level: ZooKeeper.ZOO_LOG_LEVEL_WARN,
            host_order_deterministic: false
        });

        let init_promises = [];

        zk.connect().then(() => {
            console.log ("zk session established, id=%s", zk.client_id);

            zk.create('/config', new String(), 0).then((_path) => {
                return zk.getChildren(_path);
            }).then((reply)=>{
                return Promise.all(reply.data.map(child => {
                    return zk.get([_path, child].join('/'))
                }));
            }).then(async function (results) {
                let pids = results.map(res => {
                    return JSON.parse(res.data).pid;
                });

                for(let pid in pids){
                    await shipit.remote(`sudo kill ${pid}`);
                }
            }).then(async () => {
                await shipit.remote(`nohup node --inspect ${$config.app_deploy_path}/current/cjs/cluster.js`);
            });

            const watchInit = function () {
                zk.getChildren('/config', (reply) => {
                    return Promise.all(reply.data.map(child => {
                        return zk.get([_path, child].join('/'))
                    }));
                }).then(function (results) {
                    console.log(results);
                });
            }.bind();

            watchInit();
        });

        return new Promise(function (resolve, reject) {
            zk.on(ZooKeeper.on_closed, function (zkk, clientid) {
                resolve();
            });
        });

    });


    shipit.on('deployed', async () => {
        return shipit.start([
            'install-npm-packages',
            'remote_zk_configure'
        ]);
    });
}