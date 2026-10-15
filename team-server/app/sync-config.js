// Team-Abgleich mit dem Hauskarte-Server auf dem Büro-Laptop (gleiche Adresse wie die App).
// Auf GitHub (öffentliche Kopie für automatische Updates) bleibt der Abgleich aus.
window.HAUSKARTE_SYNC = /github\.io$/.test(location.hostname) ? {} : { url: location.origin, key: 'hauskarte', domain: '' };
