import q from "q";
import * as $config from "../../cluster";

class DeploymentNode extends Node{
    constructor(){
        super();
        this.zk_path = '/config';
        this.init_promise = this.init();
    }

    init(){
        return zk.connect().then(async () => {
            console.log ("zk session established, id=%s", zk.client_id);

            await zk.create('/lock').then(()=>{}, reason=>{
                console.warn(`Could not create root-level /lock node: ${reason}`);
            });

            await zk.create('/config').then(()=>{}, reason=>{
                console.warn(`Could not create root-level /config node: ${reason}`);
            });

            return zk.getChildren('/config').then((reply)=>{
                return q.all(reply.children.map(_child => {
                    return zk.getChildren(path.join('/config', _child)).then(async reply => {
                        reply.children.forEach(async __child => {
                            await zk.delete(path.join('/config', _child, __child)).then(() => {}, reason => {
                                console.warn(`Cannot delete ${path.join('/config', _child, __child)}: ${reason}`);
                            });
                        });

                        await zk.delete(path.join('/config', _child)).then(()=>{}, reason => {
                            console.warn(`Cannot delete ${path.join('/config', _child )}: ${reason}`);
                        });
                    });
                }));
            }).then(() => {
                shipit.remote(`nohup node --inspect=9222 ${$config.app_deploy_path}/current/cjs/nodes/manager_node.js > ${$config.app_deploy_path}/current/tmp/manager.log &`);
                return true;
            }).then(() => {
                return this.monitorInitialized($config.nodes.length);
            }).then(() => {
                zk.close();
            });
        });
    }
}