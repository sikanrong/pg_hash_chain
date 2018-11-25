const fetch = require('node-fetch');
const $package = require('../../package.json');

const addLink = () => {
    return fetch(`${$package.pghc.public_api_base}/chain`, {method: 'POST'})
    .then((resp) => resp.json())
    .then(_o => {
        console.log(_o);

        if(process.send){
            process.send({
                message: 'link_added',
                value: _o
            });
        }

        return addLink();
    });
};

addLink();