# SECURITY.md — Cryptographic Architecture & Threat Model
### VanishText {Made by SUVX}

This document details the security model, cryptographic implementation, threat considerations, and verification procedures implemented in **VanishText**.

---

## 1. Threat Model

### Assets to Protect
1. **Chat Message Plaintext**: Must only be readable by the two designated participants in the active room.
2. **Cryptographic Key Material**: Ephemeral private keys and derived AES session keys must never be exposed to signaling brokers, servers, storage, or third parties.
3. **Room Isolation**: Messages belonging to room $A$ must never be decipherable or accepted in room $B$.
4. **Authenticity & Integrity**: In-flight modifications, replays, or injection of messages must be detected and rejected immediately.

### Adversary Capabilities Considered
- **Passive Network Eavesdropper (ISP / Public Wi-Fi)**: Can inspect unencrypted network traffic.
  - *Defense*: Protected by transport encryption (HTTPS / WSS / WebRTC DTLS) and application-layer AES-256-GCM.
- **Compromised Signaling Broker (PeerJS / WebRTC Relay)**: The signaling server facilitates WebRTC rendezvous and could attempt to read payloads.
  - *Defense*: All chat payloads are end-to-end encrypted before transmission. The broker never receives private keys or plaintext.
- **Active Man-in-the-Middle (MITM)**: An attacker attempting to substitute their own public keys during the ECDH handshake.
  - *Defense*: The Short Authentication String (SAS) 6-digit verification code and visual fingerprint derived from the shared secret allow participants to detect key tampering out-of-band.
- **Replay / Reordering Attacker**: Re-transmitting previously intercepted ciphertext payloads.
  - *Defense*: Every message includes a strictly monotonic sequence number ($seq$) authenticated via Additional Authenticated Data (AAD). If $seq \le lastSeenSeq$, the message is rejected.
- **Cross-Room Injection**: Attempting to replay valid ciphertext from one room into another.
  - *Defense*: The unique `roomId` is cryptographically bound into the AAD of every message. Attempting to decrypt the payload in a different room results in an authentication tag failure.

---

## 2. Cryptographic Protocol Specifications

All cryptographic operations are executed natively using the standardized **W3C Web Crypto API** (`window.crypto.subtle`). No custom cipher algorithms are invented.

### A. Invitation Code Generation
- **Entropy Source**: `crypto.getRandomValues(new Uint8Array(12))`
- **Alphabet**: 32 unambiguous alphanumeric characters (`23456789ABCDEFGHJKLMNPQRSTUVWXYZ`), eliminating easily confused glyphs (`0`, `O`, `1`, `I`).
- **Keyspace**: $32^{12} \approx 1.15 \times 10^{18}$ possible combinations (~60 bits of cryptographic entropy).
- **Format**: `XXXX-XXXX-XXXX`

### B. Key Agreement: Ephemeral ECDH (P-256)
- **Algorithm**: Elliptic Curve Diffie-Hellman (`ECDH`).
- **Named Curve**: NIST P-256 (`prime256v1`).
- **Key Extractability**: Private key is non-extractable from memory where supported. Public key is exported in JWK format and exchanged over the signaling channel during room rendezvous.
- **Shared Secret Derivation**: Both participants calculate 256 bits of shared secret material via `crypto.subtle.deriveBits()`.

### C. Key Derivation: HKDF (SHA-256)
Using RFC 5869 HKDF:
1. **AES-256-GCM Key**:
   $$\text{AESKey} = \text{HKDF-Expand}(\text{PRK}, \text{"vanishtext-v1-aes-gcm:"} \parallel \text{roomId}, 256)$$
2. **SAS Authentication Bits**:
   $$\text{SASBits} = \text{HKDF-Expand}(\text{PRK}, \text{"vanishtext-v1-sas-auth:"} \parallel \text{roomId}, 128)$$

### D. Short Authentication String (SAS) & Visual Fingerprint
To defend against active MITM on the signaling channel:
- **6-Digit Code**: Computed from the first 4 bytes of $\text{SASBits}$ modulo $1,000,000$ (e.g. `849 204`).
- **Visual Fingerprint**: 4 security emojis mapped from bytes 4–7 (e.g. `🛡️ ⚡ 🔑 🔒`).
- **Hex Fingerprint**: 16 bytes displayed as 32 hex digits grouped into 4-character blocks.
- **Procedure**: Alice and Bob compare this code out-of-band. If they match, the session is free from MITM.

### E. Authenticated Encryption: AES-256-GCM
- **Cipher**: AES-GCM (Galois/Counter Mode) with 256-bit key and 128-bit authentication tag.
- **IV Generation**: A fresh, cryptographically secure 96-bit (12-byte) random initialization vector is generated for every single message via `crypto.getRandomValues()`.
- **Additional Authenticated Data (AAD)**:
  $$\text{AAD} = \text{UTF-8}(\text{roomId} \parallel \text{":"} \parallel \text{senderId} \parallel \text{":"} \parallel \text{seq})$$
- **Decryption & Verification**: If any byte of the ciphertext, IV, tag, or AAD is modified, `crypto.subtle.decrypt()` fails, the message is rejected, and a security warning is logged.

---

## 3. Room Authorization & Participant Admission Control

- **Strict Limit**: Maximum of 2 participants per room.
- **Admission Enforcement**:
  - Participant 1 is the room creator.
  - Participant 2 is the invited guest who connects with the matching room code.
  - When a third client connects to the room host, the host immediately transmits:
    `{ type: "ROOM_FULL", message: "This room is full. Only two participants are allowed." }`
    and closes the connection.
  - The third participant is rejected before any key exchange occurs.

---

## 4. Zero Message Persistence & Expiration Lifecycle Policy

- **Independent 15-Minute Message Deletion**: Every message automatically disappears from both users' chat screens exactly 15 minutes after it was sent. Each message maintains its own independent 15-minute timer based on verified creation time, with background active sweepers enforcing removal even after tab sleep or background throttling.
- **Immediate Leave-Room Message Wiping**: Clicking **LEAVE ROOM** (or closing/refreshing the page) immediately clears all displayed chat messages for that user and purges all active message timers. Messages are never saved to `localStorage`, `sessionStorage`, `IndexedDB`, databases, persistent queues, or chat logs, and cannot be restored upon rejoining or refreshing.
- **1-Hour Real Elapsed Room Expiration**: Every room has an immutable 1-hour lifespan measured using real elapsed time (monotonic performance clocks and synchronized time authorities). When 1 hour passes from creation:
  - Both participants are immediately disconnected.
  - The chat interface is completely cleared.
  - The room invitation code is permanently invalidated.
  - The expired room is permanently disabled.
- **Prohibition on Room Reactivation**: An expired room cannot be reopened or reactivated. The creator must generate a completely new room with a brand-new CSPRNG invitation code and fresh ephemeral keys.
- **Defense Against Clock Tampering**: Real elapsed time is tracked using `Math.max(wallTimeDelta, monotonicPerfDelta)` and validated server timestamps, preventing clients from rolling back their system clock to prolong message or room lifespans.

---

## 5. Defense Against Common Web Vulnerabilities

- **Cross-Site Scripting (XSS)**: All user-supplied text (nicknames, room names, message bodies) is rendered via `document.createTextNode()` and `element.textContent`. No `innerHTML` interpolation is used for message content.
- **Eval & Dynamic Execution**: Zero use of `eval()`, `new Function()`, or dynamic script injection.
- **No Secret Key Leakage**: The frontend code contains zero private server keys, database credentials, or privileged API tokens.

---

## 6. Known Security Limitations & Non-Goals

1. **Hardware / OS-Level Capture**: No web browser can prevent operating-system screenshot utilities, external screen recorders, or someone photographing the physical screen with another camera.
2. **Client Endpoint Integrity**: If a user's machine is compromised by keyloggers, screen recording trojans, or malicious browser extensions with full DOM access, browser-based cryptography cannot guarantee confidentiality.
3. **Metadata**: External infrastructure (such as STUN servers or signaling relays) necessarily processes network metadata (IP addresses, connection timestamps, packet sizes) to establish network routes.
