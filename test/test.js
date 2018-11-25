import test from "ava";
import {fork} from "child_process";
import path from "path";

test('ten second high-load run with verification', async t => {
    const creator = fork(path.join(__dirname, 'workers', 'creator.js'));

    return new Promise((_res, _rej) => {
        creator.on('message', _m => {
            console.log(_m);
        });
    });

});

process.on('exit', () => {
    process.kill(creator.pid);
});