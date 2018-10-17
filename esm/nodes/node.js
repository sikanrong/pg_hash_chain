export default class Node {

    constructor(){
        this.zk_path = null;
        this.zk = null;
        this.pid = process.pid;
    }

    init(){
        process.on('exit', this.closeConnection.bind(this));
        process.on('SIGINT', this.closeConnection.bind(this));
        process.on('SIGUSR1', this.closeConnection.bind(this));
        process.on('SIGUSR2', this.closeConnection.bind(this));
    }

    async apoptosis(){ //programmed cluster death
        console.log("Node death requested. %s is shutting down...", this.zk_path);
        await this.closeConnection();
        process.exit(0);
    }

    apoptosisMonitor () {
        console.log("Monitoring for signs of shutdown signal...");
        this.zk.exists(this.zk_path, true).then(reply => {
            if(!reply.stat){
                this.apoptosis();
            }else{
                reply.watch.then(event => {
                    if(event.type == 'deleted'){
                        this.apoptosis();
                    }else{
                        this.apoptosisMonitor()
                    }
                });
            }
        }, () => {
            this.apoptosis();
        });
    }

    async closeConnection () {
        await this.zk.delete(this.zk_path).then(()=>{}, reason => {
            console.warn(`Could not delete ${this.zk_path}: ${reason}`);
        });

        this.zk.close();

    }

}