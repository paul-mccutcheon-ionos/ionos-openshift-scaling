# IONOS OpenShift Scaling Tool

A self-hosted web application for managing OpenShift worker node scaling on IONOS Cloud infrastructure — provisioning new nodes, monitoring installation progress, and managing the IONOS Machine API autoscaler.

## Features

- **Add Worker Nodes** — step-by-step wizard to create and attach new IONOS Cloud servers as OpenShift worker nodes
- **RHCOS Image Management** — upload Red Hat CoreOS images to IONOS FTP and register as custom images
- **Bootstrap ISO Generation** — generate NMState-configured ignition ISOs for automated node provisioning
- **SSH Progress Monitoring** — live installation progress via SSH to both the management host and worker node
- **CSR Approval** — list and approve pending Certificate Signing Requests for new nodes
- **IONOS Machine API Autoscaler** — deploy and configure the IONOS Machine API provider for cluster autoscaling
- **Client-side .env upload** — load credentials in-browser without transmitting them to the server
- **Password-protected server prefill** — bcrypt-hashed password protects server-side credential auto-fill

## Quick Start

```bash
cp .env.example .env
# Fill in your credentials in .env
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Configuration

Copy `.env.example` to `.env` and fill in your values:

| Variable | Description |
|---|---|
| `OCP_CLUSTER_API_URL` | OpenShift cluster API endpoint (port 6443) |
| `OCP_BEARER_TOKEN` | OpenShift bearer token — obtain with `oc whoami -t` |
| `OCP_MGMT_HOST` | Public IP or hostname of the management / bastion host |
| `OCP_MGMT_HOST_SSH_KEY` | SSH private key for the management host (PEM, `\n`-escaped) |
| `OCP_WORKER_SSH_KEY` | SSH private key for worker nodes (core user) |
| `OCP_WORKER_NAME_PREFIX` | Default hostname prefix for new worker nodes |
| `OCP_BOOTSTRAP_DNS` | DNS servers for the bootstrap ISO NM keyfile |
| `OCP_BOOTSTRAP_GATEWAY` | NAT Gateway IP for the private worker LAN |
| `OCP_BOOTSTRAP_PREFIX_LENGTH` | CIDR prefix length for the worker private LAN subnet |
| `IONOS_API_TOKEN` | IONOS Cloud API token (from DCD → API Keys) |
| `IONOS_FTP_USER` | IONOS DCD account email (for RHCOS image FTP upload) |
| `IONOS_FTP_PASS` | IONOS DCD account password |
| `REGISTRY_TYPE` | Container registry type: `dockerhub` \| `ghcr` \| `ionos` \| `custom` |
| `REGISTRY_IMAGE` | Full image reference for the IONOS Machine API provider |
| `REGISTRY_USERNAME` | Registry credentials (leave blank for public images) |
| `REGISTRY_PASSWORD` | Registry password |
| `AUTH_CONTRACT_ID` | Display identifier shown in the password prompt (optional) |
| `AUTH_PASSWORD_HASH` | bcrypt hash to password-protect server-side credential auto-fill (optional) |
| `PORT` | Server port (default: 3000) |

Generate a password hash:
```bash
node -e "require('bcryptjs').hash('yourpassword',10).then(h=>console.log(h))"
```

## Notes

- Bearer tokens expire — update `OCP_BEARER_TOKEN` in `.env` when you receive a 401 error
- SSH keys in `.env` must have newlines replaced with `\n` (literal backslash-n)
- The bootstrap ISO requires a reachable ignition HTTP server at the address embedded during generation
- CSR approval requires the node to have reached the bootstrap phase and contacted the API server
