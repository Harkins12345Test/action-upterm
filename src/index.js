import os from "os";
import fs from "fs";
import path from "path";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { Octokit } from "@octokit/rest";
const { createActionAuth } = require("@octokit/auth-action");

import { execShellCommand } from "./helpers";

const UPTERM_VERSION = "v0.7.6";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run() {
  try {
    if (process.platform === "win32") {
      core.info("Windows is not supported by upterm, skipping...");
      return;
    }

    core.debug("Installing dependencies");
    if (process.platform == "linux") {
      await execShellCommand(
        `curl -sL https://github.com/owenthereal/upterm/releases/download/${UPTERM_VERSION}/upterm_linux_amd64.tar.gz | tar zxvf - -C /tmp upterm && sudo install /tmp/upterm /usr/local/bin/`
      );
      await execShellCommand(
        "if ! command -v tmux &>/dev/null; then sudo apt-get -y install tmux; fi"
      );
    } else {
      await execShellCommand("brew install owenthereal/upterm/upterm");
      await execShellCommand("brew install tmux");
    }
    core.debug("Installed dependencies successfully");

    const sshPath = path.join(os.homedir(), ".ssh");
    if (!fs.existsSync(path.join(sshPath, "id_rsa"))) {
      core.debug("Generating SSH keys");
      fs.mkdirSync(sshPath, { recursive: true });
      try {
        await execShellCommand(
          `ssh-keygen -q -t rsa -N "" -f ~/.ssh/id_rsa; ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/id_ed25519`
        );
      } catch {}
      core.debug("Generated SSH keys successfully");
    } else {
      core.debug("SSH key already exists");
    }

    core.debug("Configuring ssh client");
    const sshConfigFile = fs.readFileSync(path.join(sshPath, "config"), {encoding: "utf-8"})
    console.debug(sshConfigFile)
    fs.appendFileSync(
      path.join(sshPath, "config"),
      "Host *\nStrictHostKeyChecking no\nCheckHostIP no\n" +
        "TCPKeepAlive yes\nServerAliveInterval 30\nServerAliveCountMax 180\nVerifyHostKeyDNS yes\nUpdateHostKeys yes\n"
    );
    // entry in known hosts file in mandatory in upterm. attempt ssh connection to upterm server
    // to get the host key added to ~/.ssh/known_hosts
    if (
      core.getInput("ssh-known-hosts") &&
      core.getInput("ssh-known-hosts") !== ""
    ) {
      core.info(
        "Appending ssh-known-hosts to ~/.ssh/known_hosts. Contents of ~/.ssh/known_hosts:"
      );
      fs.appendFileSync(
        path.join(sshPath, "known_hosts"),
        core.getInput("ssh-known-hosts")
      );
      core.info(await execShellCommand("cat ~/.ssh/known_hosts"));
    } else {
      try {
        core.info("Checking if known_hosts exists and is setup");
        const knownHostsSetup = await execShellCommand(
          'ssh-keygen -F uptermd.upterm.dev | awk \'$0 !~ /^#/\' | awk \'{for(i=1;i<=NF;i++){if($i~/^|[0-9]+|/)c1++;if($i~/@cert-authority/)c2++}} END{if(c1>=1 && c2>=1 && c1+c2>=2){print "known_hosts correctly setup"} else {required = ""; if(c1==0){(c2==0) ? required = required "Public Key," : required = required "Public Key"}if(c2==0){required = required "Cert Authority"}print required}}\''
        );
        const knownHostsSetupIssues = knownHostsSetup.split(",");
        if (
          fs.existsSync(path.join(sshPath, "known_hosts")) &&
          knownHostsSetupIssues.length === 1 &&
          knownHostsSetupIssues[0].trim() === "Cert Authority"
        ) {
          core.info("known_hosts exists but requires CA setup");
          await execShellCommand(
            'cat <(ssh-keygen -F uptermd.upterm.dev | awk \'/^|[0-9]+|/ { print "@cert-authority * " $2 " " $3 }\') >> ~/.ssh/known_hosts'
          );
        } else if (
          fs.existsSync(path.join(sshPath, "known_hosts")) &&
          knownHostsSetupIssues.length > 1
        )  {
          core.info(
            "Generating ~/.ssh/known_hosts by getting key from uptermd.upterm.dev"
          );
          await execShellCommand(
            "ssh-keyscan -H uptermd.upterm.dev >> ~/.ssh/known_hosts"
          );
          await execShellCommand(
            'cat <(ssh-keygen -F uptermd.upterm.dev | awk \'/^|[0-9]+|/ { print "@cert-authority * " $2 " " $3 }\') >> ~/.ssh/known_hosts'
          );
        } else {
          core.info(
            "No issues found with known_hosts"
          );
        }
      } catch {}
      // @cert-authority entry is the mandatory entry. generate the entry based on the known_hosts entry key
    }

    let authorizedKeysParameter = "";

    let allowedUsers = core
      .getInput("limit-access-to-users")
      .split(/[\s\n,]+/)
      .filter((x) => x !== "");
    if (core.getInput("limit-access-to-actor") === "true") {
      core.info(`Adding actor "${github.context.actor}" to allowed users.`);
      allowedUsers.push(github.context.actor);
    }
    const uniqueAllowedUsers = [...new Set(allowedUsers)];
    if (uniqueAllowedUsers.length > 0) {
      core.info(
        `Fetching SSH keys registered with GitHub profiles: ${uniqueAllowedUsers.join(
          ", "
        )}`
      );
      const octokit = new Octokit({
        authStrategy: createActionAuth,
      });
      let allowedKeys = [];
      for (const allowedUser of uniqueAllowedUsers) {
        if (allowedUser) {
          try {
            let keys = await octokit.users.listPublicKeysForUser({
              username: allowedUser,
            });
            for (const item of keys.data) {
              allowedKeys.push(item.key);
            }
          } catch (error) {
            core.info(
              `Error fetching keys for ${allowedUser}. Error: ${error.message}`
            );
          }
        }
      }
      if (allowedKeys.length === 0) {
        throw new Error(
          `No public SSH keys registered with GitHub profiles: ${uniqueAllowedUsers.join(
            ", "
          )}`
        );
      }
      core.info(`Fetched ${allowedKeys.length} ssh public keys`);
      const authorizedKeysPath = path.join(sshPath, "authorized_keys");
      const authorizedKeys = fs.readFileSync(authorizedKeysPath, {encoding: "utf-8"})
      fs.appendFileSync(authorizedKeysPath, allowedKeys.join("\n"));
      authorizedKeysParameter = `-a "${authorizedKeysPath}"`;
    }

    const uptermServer = core.getInput("upterm-server");
    const waitTimeoutMinutes = core.getInput("wait-timeout-minutes");
    core.info(
      `Creating a new session. Connecting to upterm server ${uptermServer}`
    );
    await execShellCommand(
      `tmux new -d -s upterm-wrapper -x 132 -y 43 \"upterm host --server '${uptermServer}' ${authorizedKeysParameter} --force-command 'tmux attach -t upterm' -- tmux new -s upterm -x 132 -y 43\"`
    );
    await sleep(2000);
    await execShellCommand("tmux send-keys -t upterm-wrapper q C-m");
    // resize terminal for largest client by default
    await execShellCommand(
      "tmux set -t upterm-wrapper window-size largest; tmux set -t upterm window-size largest"
    );
    console.debug("Created new session successfully");
    if (waitTimeoutMinutes !== "") {
      let timeout;
      try {
        timeout = parseInt(waitTimeoutMinutes);
      } catch (error) {
        core.error(
          `wait-timeout-minutes must be set to an integer. Error: ${error}`
        );
        throw error;
      }
      await execShellCommand(
        `( sleep $(( ${timeout} * 60 )); if ! pgrep -f '^tmux attach ' &>/dev/null; then tmux kill-server; fi ) & disown`
      );
      core.info(
        `wait-timeout-minutes set - will wait for ${waitTimeoutMinutes} minutes for someone to connect, otherwise shut down`
      );
    }

    core.debug("Fetching connection strings");
    await sleep(1000);

    console.debug("Entering main loop");
    while (true) {
      try {
        core.info(
          await execShellCommand(
            'bash -c "upterm session current --admin-socket ~/.upterm/*.sock"'
          )
        );
      } catch (error) {
        core.info(error.message);
        break;
      }

      const skip =
        fs.existsSync("/continue") ||
        fs.existsSync(path.join(process.env.GITHUB_WORKSPACE, "continue"));
      if (skip) {
        core.info(
          "Exiting debugging session because '/continue' file was created"
        );
        break;
      }
      await sleep(30000);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}
