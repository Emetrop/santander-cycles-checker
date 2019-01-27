const fetch = require('node-fetch');
const express = require('express');
const firebase = require('firebase/app');
require("firebase/database");

const port = process.env.PORT || 3000;

const homepage = 'https://tfl.gov.uk/modes/cycling/santander-cycles/find-a-docking-station';

const path = 'BikePoint';

const urlRegex = /tfl.apiUrl[ ]?=[ ]?"([\w:\/.-]*)";/;

const config = {
    apiKey: process.env.API_KEY,
    authDomain: process.env.AUTH_DOMAIN,
    databaseURL: process.env.DATABASE_URL,
    projectId: process.env.PROJECT_ID,
    storageBucket: process.env.STORAGE_BUCKET,
    messagingSenderId: process.env.MESSAGING_SENDER_ID,
};

const getPlaces = (url) => fetch(url).then(data => data.json());

const getProperty = (place, key) => place.additionalProperties.find(prop => prop.key === key);

const cleanPlace = (place) => ({
    id: Number(place.id.replace('BikePoints_', '')),
    name: place.commonName,
    lat: place.lat,
    lon: place.lon,
    capacity: Number(getProperty(place, 'NbDocks').value),
    bikes: Number(getProperty(place, 'NbBikes').value),
    terminalName: getProperty(place, 'TerminalName').value,
    installDate: Number(getProperty(place, 'InstallDate').value),
});

const cleanPlaces = (places) => places.map(cleanPlace);

const sortPlaces = (places) => places.sort((a, b) => a.id - b.id);

const getChanges = (places) => places.map(({id, bikes}) => ({id, bikes}));

const formatChanges = (places) => places.reduce((acc, place) => `${acc}${place.id}:${place.bikes};`, '');

const getUrl = () => fetch(homepage)
    .then(data => data.text())
    .then(page => urlRegex.exec(page)[1])
    .then(url => url + path);

const checkChanges = async (res, timestamp) => {
    console.log(`New parsing at ${timestamp}!`);

    try {
        const url = await getUrl()
            .catch(error => {
                console.error('URL has not been successfully parsed!');
                throw Error(error);
            });

        const places = await getPlaces(url)
            .then(cleanPlaces)
            .then(sortPlaces)
            .catch(error => {
                console.error('Places has not been successfully parsed!');
                throw Error(error);
            });

        // get saved stations
        const savedPlaces = await firebase
            .database()
            .ref('/knownStations/')
            .once('value')
            .then((snapshot) => snapshot.val())
            .then((ids) => ids.split(';').map(Number))
            .catch(error => {
                console.error('KnownStations has not been successfully fetched!');
                throw Error(error);
            });

        const missingPlaces = [];

        // check for missing places
        savedPlaces.forEach(id => {
            if (!places.find(p => p.id === id)) {
                missingPlaces.push(id);
            }
        });

        if (missingPlaces.length > 0) {
            console.log(`Some stations have not been found - ${missingPlaces.join(', ')}.`);
        }

        const newPlaces = [];

        // check for new stations
        for (const place of places) {
            if (savedPlaces.indexOf(place.id) !== -1) {
                continue;
            }

            try {
                await firebase
                    .database()
                    .ref('stations/' + place.id)
                    .set({...place, found: timestamp});

                newPlaces.push(place.id);
            } catch (error) {
                console.error(`Error during saving new station with ID ${place.id}!`, JSON.stringify(place), error);
            }
        }

        if (newPlaces.length > 0) {
            console.log(`Some new stations have been found - ${newPlaces.join(', ')}.`);

            try {
                await firebase
                    .database()
                    .ref('knownStations/')
                    .set([...savedPlaces, ...newPlaces].join(';'));
            } catch (error) {
                console.error(`Error during saving knownStations!`, error);
            }
        }

        const changes = formatChanges(getChanges(places));

        // save new changes
        firebase
            .database()
            .ref('changes/' + timestamp)
            .set({data: `${timestamp}-${changes}`})
            .catch(error => {
                console.error('Changes has not been successfully fetched!');
                throw Error(error);
            });

        console.log(`Successfully parsed at ${timestamp}!`);

        res.status(200).json({success: true});
    } catch (error) {
        console.error(`Parsing failed at ${timestamp}!`, error);
        res.status(200).json({success: false, error});
    }
};

const isAccessApproved = (req) => req.query.fetch === '1';

const app = express();

firebase.initializeApp(config);

app.get('/', (req, res) => {
    const timestamp = Math.floor(Date.now() / 1000);

    if (!isAccessApproved(req)) {
        console.log(`Not permitted parsing at ${timestamp}!`);
        res.status(200).json({success: false, error: 'Not permitted access.'});
        return;
    }

    checkChanges(res, timestamp);
});

app.get('/station/:id', (req, res) => {
    if (!isAccessApproved(req)) {
        res.status(400).send('Not found.');
        return;
    }

    firebase
        .database()
        .ref('stations/' + req.params.id)
        .once('value')
        .then((snapshot) => snapshot.val())
        .then((station) => station ? res.json(station) : res.status(400).send('Not found.'));
});

app.get('/change/:id', (req, res) => {
    if (!isAccessApproved(req)) {
        res.status(400).send('Not found.');
        return;
    }

    firebase
        .database()
        .ref('changes/' + req.params.id)
        .once('value')
        .then((snapshot) => snapshot.val())
        .then((changes) => changes ? res.send(changes.data) : res.status(400).send('Not found.'));
});

app.listen(port, () => console.log(`App listening on port ${port}!`));
