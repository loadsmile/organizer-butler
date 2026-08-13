import http from "node:http";
import https from "node:https";
import net from "node:net";

const deny = () => {
  throw new Error("Outbound request attempted");
};

globalThis.fetch = deny;
http.request = deny;
https.request = deny;
net.connect = deny;
net.createConnection = deny;
