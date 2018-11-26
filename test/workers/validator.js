const fetch = require('node-fetch');
const $package = require('../../package.json');
const md5 = require('md5');

const validateRecent = () => {
    return fetch(`${$package.pghc.public_api_base}/chain/recent`)
        .then((resp) => resp.json())
        .then(_o => {

            let isValid = true;
            let prevChain = null;

            _o.reverse().forEach(_c => {
                if(prevChain){
                    const correct_md5 = md5(_c.zk_id + _c.node_id + prevChain.hash);
                    if(_c.hash != correct_md5){
                        isValid = false;
                    }
                }

                prevChain = _c;
            });

            console.log(isValid);
            if(process.send){
                process.send({
                    message: (isValid? 'pass' : 'fail')
                });
            }

            setTimeout(validateRecent, 200);
        });
};

validateRecent();