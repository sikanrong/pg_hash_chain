import q from "q";
import * as $config from "../../cluster";
import * as path from "path";
import Node from "./node";

export default class DeploymentNode extends Node{
    constructor(spawn_remote){
        super();
        this.zk_path = '/config';
        this.spawn_remote = spawn_remote;
        this.init_promise = this.init();
    }

    init(){
        return this.zk.connect().then(async () => {
            console.log ("zk session established, id=%s", this.zk.client_id);

            await this.zk.create('/lock').then(()=>{}, reason=>{
                console.warn(`Could not create root-level /lock node: ${reason}`);
            });

            await this.zk.create('/config').then(()=>{}, reason=>{
                console.warn(`Could not create root-level /config node: ${reason}`);
            });

            return this.zk.getChildren('/config').then(async (reply)=>{
                reply.children.forEach(async _child => {
                    const _r = await this.zk.get(path.join('/config', _child));
                    const _o = JSON.parse(_r.data);
                    await this.zk.delete(path.join('/config', _child), _r.stat.version).then(()=>{}, reason => {
                        console.warn(`Cannot delete ${path.join('/config', _child )}: ${reason}`);
                    });
                });
            }).then(() => {
                this.spawn_remote();
                return true;
            }).then(() => {
                return this.monitorInitialized($config.nodes.length + ($config.nodes.length * ($config.pg_slave_count + 1)));
            }).then(() => {
                this.zk.close();
            });
        });
    }
}