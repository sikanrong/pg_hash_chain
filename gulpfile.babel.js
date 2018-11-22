import gulp from "gulp";
import Handlebars from "handlebars";
import * as fs from "fs"
import * as $package from "./package.json"
import path from "path";
import K8s from "kubernetes-client";
import uuidv1 from "uuid/v1";
import yaml from "js-yaml";

let client;

gulp.task("k8s-connect", async () => {
    client = new K8s.Client({ config: K8s.config.fromKubeconfig(), version: '1.10' });
    await client.loadSpec();
});

const createOrUpdate = async (endpoint, payload) => {
    return await endpoint.post(payload).catch(async _e => {
        if(_e.message.indexOf('already exists') >= 0){
            return await endpoint(payload.body.metadata.name).patch(payload).catch(_e => {
                throw new Error (_e);
            });
        }
    })
};

gulp.task("k8s-configmaps", ["k8s-connect"], async () => {

    const conf_payload = {
        kind: "ConfigMap",
        metadata: {
            name: "pg-conf"
        },
        data: {}
    };

    //Get number of replicas from the configuration
    const pgReplSet = yaml.safeLoad(fs.readFileSync(path.join(__dirname, 'kubernetes', 'controllers', 'postgres-repl.statefulset.spec.k8s.yaml')));
    const bdr_node_seq = Array.apply(null, {length: pgReplSet.spec.replicas}).map(Number.call, Number);

    //Copy Postgres conf to Kubernetes ConfigMap
    const pgHbaConf = `
      host all all 0.0.0.0/0 trust
      host replication all 0.0.0.0/0 trust
      
      local all all trust
      local replication all trust
    `.replace(/^\s+/gm, '').trim();

    conf_payload.data["pg_hba.conf"] = pgHbaConf;

    const slave_indices = Array.from(Array(pgReplSet.spec.replicas).keys());

    const nodesPerDataCenter = parseInt( pgReplSet.spec.replicas / $package.pghc.num_bdr_groups );

    const pgReplNames = slave_indices.filter(_i => {
        if ((_i % nodesPerDataCenter) == 0){
            return false;
        }else{
            return true;
        }
    }).map(_i => {
        return `${pgReplSet.metadata.name}-${_i}`
    });

    let template;

    //Write PostgreSQL WAL-replica (slave) node configuration files.

    slave_indices.forEach(_i => {
        let _master_idx = (parseInt( _i / nodesPerDataCenter ) * nodesPerDataCenter);
        const wal_path = `${$package.pghc.wal_archive_path}/${_master_idx}`;


        if(_i == _master_idx){
            let template = Handlebars.compile(fs.readFileSync('./remote_cfg/postgresql.master.conf', 'utf8'), {noEscape: true});
            const pgMasterConf = template({
                wal_archive_path: wal_path,
                synchronous_standby_names: pgReplNames.join(', ')
            });

            template = Handlebars.compile(fs.readFileSync('./remote_cfg/recovery.master.conf', 'utf8'), {noEscape: true});
            const pgMasterRecovery = template({ wal_archive_path: wal_path });

            conf_payload.data[`recovery.master${_i}.conf`] = pgMasterRecovery;
            conf_payload.data[`postgresql.master${_i}.conf`] = pgMasterConf;
        }else{
            template = Handlebars.compile(fs.readFileSync('./remote_cfg/recovery.slave.conf', 'utf8'), {noEscape: true});
            const pgSlaveRecovery = template({
                wal_archive_path: wal_path,
                master_host: `${pgReplSet.metadata.name}-${_master_idx}.pghc-postgres.pghc.svc.cluster.local`,
                application_name: `${pgReplSet.metadata.name}-${_i}`
            });

            conf_payload.data[`slave${_i}.master`] = new String(_master_idx);
            conf_payload.data[`recovery.slave${_i}.conf`] = pgSlaveRecovery;
            conf_payload.data[`postgresql.slave${_i}.conf`] = fs.readFileSync('./remote_cfg/postgresql.slave.conf', 'utf8');
        }
    });

    // //Write Zookeeper configuration files
    // const conf = fs.readFileSync("remote_cfg/zoo.cfg", "utf8");
    // template = Handlebars.compile(conf, {noEscape: true});
    //
    // const zk_servers = Object.keys($config.nodes).map(myid => {
    //     return `server.${myid}\=${$config.nodes[myid].host}:${$config.zk_discovery_port}:${$config.zk_election_port}`
    // }).join("\n");
    //
    // fs.writeFileSync("./tmp/zoo.cfg", template({
    //     zk_servers: zk_servers,
    //     zk_datadir: $config.zk_datadir,
    //     zk_client_port: $config.zk_client_port
    // }));

    await client.api.v1.namespaces('pghc').configmaps('pg-conf').delete().catch(_e => {throw new Error(_e)});
    let _res = await createOrUpdate(client.api.v1.namespaces('pghc').configmaps, {body: conf_payload});
    console.log(_res);
});

gulp.task("k8s-deploy", ["k8s-connect", "k8s-configmaps"], async () => {
    const pgReplSetSpec = yaml.safeLoad(fs.readFileSync(path.join(__dirname, 'kubernetes', 'controllers', 'postgres-repl.statefulset.spec.k8s.yaml')));
    let _res = await createOrUpdate(client.apis.apps.v1.namespaces('pghc').statefulsets, {body: pgReplSetSpec});

    console.log(_res);

    const pgSrvSpec = yaml.safeLoad(fs.readFileSync(path.join(__dirname, 'kubernetes', 'services', 'pghc-postgres.service.spec.k8s.yaml')));
    _res = await createOrUpdate(client.api.v1.namespaces('pghc').services, {body: pgSrvSpec});

    console.log(_res);
});