import gulp from "gulp";
import Handlebars from "handlebars";
import * as fs from "fs"
import path from "path";
import K8s from "kubernetes-client";
import uuidv1 from "uuid/v1";
import yaml from "js-yaml";

gulp.task("compile-config-maps", async () => {
    const client = new K8s.Client({ config: K8s.config.fromKubeconfig(), version: '1.10' });
    await client.loadSpec();

    //Get number of replicas from the configuration
    const pgMasterSpec = yaml.safeLoad(fs.readFileSync(path.join(__dirname, 'kubernetes', 'controllers', 'pg-bdr-wal-master.statefulset.spec.k8s.yaml')));

    const bdr_node_seq = Array.apply(null, {length: pgMasterSpec.spec.replicas}).map(Number.call, Number);

    //Copy Postgres conf to Kubernetes ConfigMap
    const pgHbaConf = `${bdr_node_seq.map(node_idx => {
      return `
        host all all pghc-pg-bdr-wal-master-${node_idx}.pghc-pg-bdr-wal-master.pghc.svc.cluster.local trust
        host replication all pghc-pg-bdr-wal-master-${node_idx}.pghc-pg-bdr-wal-master.pghc.svc.cluster.local trust
      `;
    }).join("\n")}
      host all all 127.0.0.1/32 trust
      host replication all 127.0.0.1/32 trust
      
      host all all localhost trust
      host replication all localhost trust
      
      host all all ::1/128 trust
      host replication all ::1/128 trust

      local all all trust
      local replication all trust
    `.replace(/\s\s*$/gm, "");

    const conf_payload = {
        kind: "ConfigMap",
        metadata: {
            name: "pg-conf",
            uid: uuidv1()
        },
        data: {
            "pg_hba.conf": pgHbaConf
        }
    };
    const result = await client.api.v1.namespaces('pghc').configmaps.post({body: conf_payload})
        .catch(async _e => {
            if(_e.message.indexOf('already exists') >= 0){
                delete conf_payload.metadata.uid;
                return await client.api.v1.namespace('pghc').configmaps('pg-conf').patch({body: conf_payload}).catch(_e => {
                    throw new Error(_e);
                });
            }else{
                throw new Error(_e);
            }
        });

    const slave_indices = Array.from(Array($config.pg_slave_count).keys());

    const ssnames = slave_indices.map(_i => {
        return `slave${_i+1}`
    });

    //Write PostgreSQL master node configuration file.
    let template = Handlebars.compile(fs.readFileSync('./remote_cfg/postgresql.master.conf', 'utf8'), {noEscape: true});
    fs.writeFileSync("./tmp/postgresql.master.conf", template({
        wal_archive_path: $config.pg_wal_archive_path,
        synchronous_standby_names: ssnames.join(', ')
    }));

    //Write PostgreSQL WAL-replica (slave) node configuration files.
    slave_indices.forEach(_i => {
        const template = Handlebars.compile(fs.readFileSync('./remote_cfg/recovery.slave.conf', 'utf8'), {noEscape: true});
        fs.writeFileSync(`./tmp/recovery.slave${_i}.conf`, template({
            wal_archive_path: $config.pg_wal_archive_path,
            master_port: $config.pg_port_start,
            application_name: `slave${_i}`
        }));
    });

    //Write Zookeeper configuration files
    const conf = fs.readFileSync("remote_cfg/zoo.cfg", "utf8");
    template = Handlebars.compile(conf, {noEscape: true});

    const zk_servers = Object.keys($config.nodes).map(myid => {
        return `server.${myid}\=${$config.nodes[myid].host}:${$config.zk_discovery_port}:${$config.zk_election_port}`
    }).join("\n");

    fs.writeFileSync("./tmp/zoo.cfg", template({
        zk_servers: zk_servers,
        zk_datadir: $config.zk_datadir,
        zk_client_port: $config.zk_client_port
    }));
});