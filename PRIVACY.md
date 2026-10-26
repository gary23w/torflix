# Torflix privacy information

Last updated: October 26, 2026

Torflix does not require a Torflix account and does not include advertising or telemetry. Its network features still send information to the services and peers described below.

Torflix stores settings, playback history and resume positions, title caches, torrent metadata, and downloaded torrent data on your device. Storage and sharing behavior can be controlled in Settings. The Android application disables Android's automatic app backup.

When you search or browse, Torflix sends search queries to the public torrent index at `search.emberglow.tech`. The index is an external service, and its operator may receive your IP address and request information.

For title information and artwork, Torflix sends a title's kind, name, and year to `torflix-meta.vercel.app`. The metadata service queries Wikipedia, Wikidata, and TVmaze. Its source is included in this repository under `meta/`. The service does not maintain its own database of users or requests; its hosting platform may retain its usual request logs. If this service is disabled or unavailable, the app may contact those information sources directly. Artwork is loaded from TVmaze and Wikimedia image hosts. These services receive ordinary network request information, including your IP address.

BitTorrent connects directly to trackers and peers to find and exchange pieces of the content you select. Those participants can see your IP address and information identifying the torrent. Opening a title page can prepare its first torrent for playback; optional search preloading, preview fetching, full-video downloading, and continued sharing can create additional torrent traffic. These features have controls in Settings. Torflix does not conceal your IP address.

On Android TV, Torflix contacts GitHub at startup to check for a newer release. If an update proceeds, the APK is downloaded from GitHub and installation is handled by Android. GitHub receives ordinary request information.

Video playback, subtitle processing, and FFmpeg audio decoding run on your device. Torflix does not upload your playback history or local files to a Torflix account service. BitTorrent sharing is separate from this and follows your torrent and sharing settings.

The operators of external services control their own logging and privacy practices. Torflix cannot make guarantees about their retention or use of request information.

Questions and bug reports can be raised through the [Torflix issue tracker](https://github.com/gary23w/torflix/issues). Avoid including private information in a public issue.
