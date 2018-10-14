import * as fs from "fs";
import * as $config from "../../cluster.json";
import Handlebars from "handlebars";
import {ZooKeeper} from "zookeeper";
import * as path from "path";

//write the PID file
fs.writeFileSync(path.join(__dirname, '..', '..', '/tmp/local.pid'), process.pid);

const zk = new ZooKeeper({
    connect: `${$config.nodes[0].host}:${$config.zk_client_port}`
});

let zk_node_path = null;

zk.connect((err) => {
    if(err){
        console.log(`Connection error: '${err}'`);
        throw err;
    }

    console.log ("zk session established, id=%s", zk.client_id);

    zk.aw_get_children('_nodes_', function (type, state, path) { // this is watcher
        console.log ("get watcher is triggered: type=%d, state=%d, path=%s", type, state, path);
    }, function (rc, error, children, stat) {
        console.log(`nodes updated: ${children.length}`)
    });
});