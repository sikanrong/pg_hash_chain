import * as fs from "fs";
import * as path from "path";
import * as $config from "../../cluster.json";
import Handlebars from "handlebars";
import {ZooKeeper} from "zookeeper";

//write the PID file
fs.writeFileSync(path.join(__dirname, '..', '..', '/tmp/remote.pid'), process.pid);

const zk = new ZooKeeper({
    connect: "127.0.0.1:2181"
});

let zk_node_path = null;

zk.connect((err) => {
    if(err)
        throw err;

    console.log ("zk session established, id=%s", zk.client_id);
    zk.a_create('/_nodes_/node.js1', "", ZooKeeper.ZOO_EPHEMERAL | ZooKeeper.ZOO_SEQUENCE, (rc, error, path) => {
        if(error){
            const msg = `Unable to create node at ${path}: '${error}' rc: ${rc}`;
            console.log(msg);
            throw new Error(msg);
        }
        zk_node_path = path;

        process.nextTick(async () => {
            zk.close();
        });
    });
});