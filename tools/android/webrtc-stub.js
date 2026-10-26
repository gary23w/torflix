// SPDX-License-Identifier: MIT OR Apache-2.0
//
// Stands in for `webrtc-polyfill` in the Android backend bundle. WebTorrent imports it (through
// simple-peer) whether or not WebRTC is used, and it loads node-datachannel, a native addon
// with no Android build. Without these classes simple-peer reports no WebRTC support, so the
// engine uses TCP peers only, as the desktop already does (`tracker: { wrtc: false }`).

export const RTCPeerConnection = undefined;
export const RTCSessionDescription = undefined;
export const RTCIceCandidate = undefined;
export default {};
