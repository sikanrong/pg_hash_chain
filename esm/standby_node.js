import * as fs from "fs";
import * as path from "path";
import Handlebars from "handlebars";
import ZooKeeper from "zk";
import ZkUtil from "./zk_util"
import * as $config from "../cluster";

export default class StandbyNode{
    constructor(_p){
        this.zk_parent_path = _p;
        this.zk_path = null;
        this.zk = null;

        this.init();
    }

    async init(){
        this.zk = ZkUtil.configZookeeper();

        await this.zk.connect().then(() => {
            return this.zk.create(
                path.join(this.zk_parent_path, 'subnode.'),
                JSON.stringify({initialized: true}),
                ZooKeeper.ZOO_EPHEMERAL | ZooKeeper.ZOO_SEQUENCE
            );
        });
    }
}

process.on('message', _p => {
    new StandbyNode(_p);
});