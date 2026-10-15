# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- **Secrets**: none. The dish API needs no account, password or token, and
  the configuration has no secret field.
- **Stored in `/data`**: nothing. What the integration knows about the dish
  (its serial, the last reading) lives in memory and is read again at startup.
- **Network**: requests go only to the dish address of the configuration
  (`192.168.100.1:9200` by default), in plain gRPC over HTTP/2 on the local
  network, as the Starlink app does. The integration opens no port and calls
  no cloud service.
- **Commands**: rebooting, stowing and deploying the dish cut the Internet
  access; they are refused unless the Gladys administrator ticks "Allow the
  commands that cut the Internet", and are never exposed as a switch.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
the Starlink hardware, firmware and service, and the other devices of your
network.
