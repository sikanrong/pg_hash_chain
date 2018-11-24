import express from "express";
import * as $package from "../package.json"

const app = express();
const port = 8080;

const version = $package.version;

app.listen(port, () => {
    console.log(`HashChain API (v${$package.version}) LISTENING ${port}`);
    app.get('/ping', (req, res, next) => {
        res.send("pong");
    });
});