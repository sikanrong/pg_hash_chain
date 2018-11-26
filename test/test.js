import test from "ava";
import {fork} from "child_process";
import path from "path";

let child_ps = [];

const killChildren = () => {
    child_ps.forEach(_c => {
        try{
            process.kill(_c.pid);
        }catch(_e){
            console.log(`Could not kill child process with PID ${_c.pid}`);
        }
    });

    child_ps = [];
};

test('ten second high-load run with verification', async t => {
    child_ps.push(fork(path.join(__dirname, 'workers', 'creator.js')));
    child_ps.push(fork(path.join(__dirname, 'workers', 'creator.js')));
    child_ps.push(fork(path.join(__dirname, 'workers', 'validator.js')));

    child_ps.forEach(_c => {
        _c.on('message', _m => {
            t[_m.message]();
        });
    });

    return new Promise((_res, _rej) => {
       setTimeout(() => {
           killChildren();
           _res();
       }, 10000);
    });

});

process.on('exit', () => {
    killChildren();
});