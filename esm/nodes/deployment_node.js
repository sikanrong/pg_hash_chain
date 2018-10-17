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

            return this.zk.getChildren('/config').then((reply)=>{
                return q.all(reply.children.map(_child => {
                    return this.zk.getChildren(path.join('/config', _child)).then(async reply => {
                        reply.children.forEach(async __child => {
                            await this.zk.delete(path.join('/config', _child, __child)).then(() => {}, reason => {
                                console.warn(`Cannot delete ${path.join('/config', _child, __child)}: ${reason}`);
                            });
                        });

                        await this.zk.delete(path.join('/config', _child)).then(()=>{}, reason => {
                            console.warn(`Cannot delete ${path.join('/config', _child )}: ${reason}`);
                        });
                    });
                }));
            }).then(() => {
                this.spawn_remote();
                return true;
            }).then(() => {
                return this.monitorInitialized($config.nodes.length);
            }).then(() => {
                this.zk.close();
            });
        });
    }
}