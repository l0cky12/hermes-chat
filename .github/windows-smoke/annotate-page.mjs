// A page to annotate in the Preview (#96): a green button at a known place, so the still can be checked to show the
// page itself, and a password field holding a value, which no annotation may carry. GET / serves it.
import http from "node:http";

const port = Number(process.argv[2]);
const page = `<!doctype html><meta charset="utf-8"><title>Annotate me</title>
<body style="margin:0;background:#fff;font:16px sans-serif">
<button id="save" style="position:absolute;left:40px;top:40px;width:200px;height:80px;border:0;background:rgb(30,160,80);color:#fff">Save changes</button>
<label style="position:absolute;left:40px;top:160px">Password <input type="password" value="hunter2-smoke"></label>
</body>`;
http
  .createServer((req, res) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page);
  })
  .listen(port, "127.0.0.1", () => console.log(`annotate page on ${port}`));
