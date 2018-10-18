import q from "q";
import * as $config from "../../cluster";
import * as path from "path";
import Node from "./node";
import remote_exec from "ssh-exec";

export default class DeploymentNode extends Node{
    constructor(spawn_remote){
        super();
        this.spawn_remote = spawn_remote;
        this.init_promise = this.init();
    }

    init(){
        return this.zk.connect().then(async () => {
            console.log ("zk session established, id=%s", this.zk.client_id);

            await this.zk.create('/lock').then(()=>{}, reason=>{
                console.warn(`Could not create root-level /lock node: ${reason}`);
            });

            return this.zk.create('/config').then(async ()=>{
                return this.zk.create('/config/deploy.', new String(), ZooKeeper.ZOO_SEQUENCE).then(_p => {
                    this.zk_path = _p;
                    return this.zk.getChildren(_p).then(async (reply)=>{

                        let _pchild = null;
                        if(reply.children.length > 1)
                            _pchild = reply.children[reply.children.length - 2];

                        if(!_pchild)
                            return;

                        const _r = await this.zk.get(path.join(_p, _pchild)).then(_r => {_r}, (reason)=>{
                            console.warn(`Cannot get data from ${path.join('/config', _pchild)}: ${reason}`);
                        });

                        const _o = JSON.parse(_r.data);

                        remote_exec(`sudo kill ${_o.pid} || echo "ERROR: ${_o.pid} is not running."`, {
                            user: _o.user,
                            host: _o.host,
                            key: $config.ssh_key
                        }).pipe(process.stdout);
                    });
                });
            }, reason=>{
                console.warn(`Could not create root-level /config node: ${reason}`);
            }).then(() => {
                this.spawn_remote(this.zk_path);
                return true;
            }).then(() => {
                return this.monitorInitialized($config.nodes.length + ($config.nodes.length * ($config.pg_slave_count + 1)));
            }).then(() => {
                this.zk.close();
            });
        });
    }
}