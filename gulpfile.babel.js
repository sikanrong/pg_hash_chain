import gulp from "gulp";
import Handlebars from "handlebars";
import * as fs from "fs"
import * as $config from "./cluster.json"

gulp.task("compile-configs", () => {
    //Write PostgreSQL configuration files to tmp directory for COPY by docker.
    fs.writeFileSync(`./tmp/pg_hba.conf`,
        `${Object.keys($config.nodes).map(myid => {
            return `
                  host all all ${$config.nodes[myid].host}/32 trust
                  host replication all ${$config.nodes[myid].host}/32 trust
              `;
        }).join("\n")}
              host all all ::1/128 trust
              host all all 127.0.0.1/32 trust
              host all all localhost trust
              host replication all ::1/128 trust
              local all all trust
              local replication all trust
          `);

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