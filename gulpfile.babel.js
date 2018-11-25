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

    await client.api.v1.namespaces.post({ body: yaml.safeLoad(fs.readFileSync(path.join(__dirname, 'kubernetes', 'pghc.namespace.spec.k8s.yaml')))}).catch(_e => {
        if(_e.code != 409){
            throw new Error(_e);
        }
    });
});

const loadConfig = async (endpoint, spec_path, _method) => {
    _method = _method || forceRecreate.bind(this);
    const _spec = yaml.safeLoad(fs.readFileSync(spec_path));
    let _res = await _method(endpoint, _spec);

    console.log(_res);
};

const createOrUpdate = async (endpoint, payload) => {
    return await endpoint.post({body: payload}).catch(async _e => {
        if(_e.message.indexOf('already exists') >= 0){
            return await endpoint(payload.metadata.name).patch({body: payload}).catch(_e => {
                throw new Error (_e);
            });
        }else{
            throw new Error(_e);
        }
    })
};

const forceRecreate = async (endpoint, payload) => {
    await endpoint(payload.metadata.name).delete().catch(_e => {
        if(_e.code != 404){
            throw new Error(_e);
        }
    });
    const _res = await endpoint.post({body: payload}).catch(_e => {throw new Error(_e)});
    console.log(_res);
    return _res;
};

gulp.task("k8s-configmaps", ["k8s-connect"], async () => {

    let conf_payload = {
        kind: "ConfigMap",
        metadata: {
            name: "pg-conf"
        },
        data: {}
    };

    //Get number of replicas from the configuration
    const pgReplSet = yaml.safeLoad(fs.readFileSync(path.join(__dirname, 'kubernetes', 'controllers', 'pghc-postgres-repl.statefulset.spec.k8s.yaml')));
    const zkReplSet = yaml.safeLoad(fs.readFileSync(path.join(__dirname, 'kubernetes', 'controllers', 'pghc-zookeeper.statefulset.spec.k8s.yaml')));
    const zk_node_set = Array.apply(null, {length: zkReplSet.spec.replicas}).map(Number.call, Number);

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
                master_host: `${pgReplSet.metadata.name}-${_master_idx}.pghc-postgres-dns.pghc.svc.cluster.local`,
                application_name: `${pgReplSet.metadata.name}-${_i}`
            });

            conf_payload.data[`slave${_i}.master`] = new String(_master_idx);
            conf_payload.data[`recovery.slave${_i}.conf`] = pgSlaveRecovery;
            conf_payload.data[`postgresql.slave${_i}.conf`] = fs.readFileSync('./remote_cfg/postgresql.slave.conf', 'utf8');
        }
    });

    await forceRecreate(client.api.v1.namespaces('pghc').configmaps, conf_payload);

    //Write Zookeeper configuration files
    const conf = fs.readFileSync("remote_cfg/zoo.cfg", "utf8");
    template = Handlebars.compile(conf, {noEscape: true});

    const zkConf = template({
        zk_servers: zk_node_set.map(_i => {
            return `server.${(_i + 1).toString()}=pghc-zookeeper-${_i}.pghc-zookeeper-dns.pghc.svc.cluster.local:2888:3888`;
        }).join("\n")
    });

    conf_payload = {
        kind: "ConfigMap",
        metadata: {
            name: "zk-conf"
        },
        data: {
            "zoo.cfg": zkConf
        }
    };

    zk_node_set.forEach(_i => {
        conf_payload.data[`zk_myid.${_i}`] = (_i + 1).toString();
    });

    await forceRecreate(client.api.v1.namespaces('pghc').configmaps, conf_payload);
});

const deployPostgresNodes = async () => {
    await loadConfig(client.apis.apps.v1.namespaces('pghc').statefulsets, path.join(__dirname, 'kubernetes', 'controllers', 'pghc-postgres-repl.statefulset.spec.k8s.yaml'));
    await loadConfig(client.api.v1.namespaces('pghc').services, path.join(__dirname, 'kubernetes', 'services', 'pghc-postgres.dns.spec.k8s.yaml'));
};

const deployZookeeper = async() => {
    await loadConfig(client.apis.apps.v1.namespaces('pghc').statefulsets, path.join(__dirname, 'kubernetes', 'controllers', 'pghc-zookeeper.statefulset.spec.k8s.yaml'));
    await loadConfig(client.api.v1.namespaces('pghc').services, path.join(__dirname, 'kubernetes', 'services', 'pghc-zookeeper.dns.spec.k8s.yaml'));
};

const deployFrontend = async() => {
    await loadConfig(client.apis.apps.v1.namespaces('pghc').statefulsets, path.join(__dirname, 'kubernetes', 'controllers', 'pghc-backend.statefulset.spec.k8s.yaml'));
    await loadConfig(client.api.v1.namespaces('pghc').services, path.join(__dirname, 'kubernetes', 'services', 'pghc-backend.loadbalancer.spec.k8s.yaml'));
    await loadConfig(client.api.v1.namespaces('pghc').services, path.join(__dirname, 'kubernetes', 'services', 'pghc-backend.dns.spec.k8s.yaml'));

    await loadConfig(client.api.extensions.v1beta1.namespaces('pghc').ingresses, path.join(__dirname, 'kubernetes', 'controllers', 'pghc-ingress.controller.spec.k8s.yaml'));
};

gulp.task("k8s-deploy-backend", ["k8s-connect", "k8s-configmaps"], deployFrontend.bind(this));
gulp.task("k8s-deploy-postgres", ["k8s-connect", "k8s-configmaps"], deployPostgresNodes.bind(this));
gulp.task("k8s-deploy-zookeeper", ["k8s-connect", "k8s-configmaps"], deployZookeeper.bind(this));

gulp.task("k8s-deploy", ["k8s-connect", "k8s-configmaps"], async () => {
    await deployPostgresNodes();
    await deployZookeeper();
    await deployFrontend();
});