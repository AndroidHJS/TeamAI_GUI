const { createConnection } = require("node:net");

const pipe = process.env.TEAMAI_ASKPASS_PIPE;
const token = process.env.TEAMAI_ASKPASS_TOKEN;
if (!pipe || !token) process.exit(2);

const socket = createConnection(pipe);
let response = "";
const timeout = setTimeout(() => {
  socket.destroy();
  process.exit(3);
}, 10_000);

socket.setEncoding("utf8");
socket.on("connect", () => socket.write(`${token}\n`));
socket.on("data", (chunk) => { response += chunk; });
socket.on("error", () => {
  clearTimeout(timeout);
  process.exit(3);
});
socket.on("end", () => {
  clearTimeout(timeout);
  if (!response.endsWith("\n")) process.exit(3);
  process.stdout.write(response, () => process.exit(0));
});
