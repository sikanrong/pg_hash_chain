import test from "ava";
import {fork} from "child_process";
import path from "path";
import fetch from "node-fetch";
import * as $package from "../package.json";

let child_ps = [];
let links_added = 0;

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

test('one minute high-load run with verification', async t => {
    await fetch(`${$package.pghc.public_api_base}/reload_schema`)
        .then(_o => {console.log(_o)});

    child_ps.push(fork(path.join(__dirname, 'workers', 'creator.js')));
    child_ps.push(fork(path.join(__dirname, 'workers', 'creator.js')));
    child_ps.push(fork(path.join(__dirname, 'workers', 'validator.js')));

    child_ps.forEach(_c => {
        _c.on('message', _m => {
            t[_m.message]();

            if(_m.type == 'chain_link_add'){
                links_added++;
            }
        });
    });

    return new Promise((_res, _rej) => {
       setTimeout(() => {
           console.log(`Links added: ${links_added}`);
           killChildren();
           _res();
       }, 60000);
    });

});

process.on('exit', () => {
    killChildren();
});