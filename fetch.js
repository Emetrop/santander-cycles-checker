const fetch = require('node-fetch');

const url = process.env.APP_URL;

fetch(`${url}?fetch=1`);
