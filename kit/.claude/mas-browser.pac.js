// MAS Office kit — proxy rules for the role browser (mas-browser). Shipped for reading; .mcp.json carries the same
// code as a base64 data: URL (a test checks they match). Hosts that resolve to loopback, private, link-local or
// carrier-grade NAT addresses, and IPv6 literals, go to a dead proxy, so a prompt-injected role cannot reach the
// user's router, local services or cloud metadata. Names and literals are also blocked by --host-resolver-rules.
function FindProxyForURL(url, host) {
  if (host.indexOf(":") >= 0) return "PROXY 0.0.0.0:9"; // IPv6 literals: no public site needs one
  var ip = /^[0-9.]+$/.test(host) ? host : dnsResolve(host);
  if (!ip) return "DIRECT";
  var nets = [["127.0.0.0","255.0.0.0"],["10.0.0.0","255.0.0.0"],["172.16.0.0","255.240.0.0"],["192.168.0.0","255.255.0.0"],
              ["169.254.0.0","255.255.0.0"],["0.0.0.0","255.0.0.0"],["100.64.0.0","255.192.0.0"]];
  for (var i = 0; i < nets.length; i++) if (isInNet(ip, nets[i][0], nets[i][1])) return "PROXY 0.0.0.0:9";
  return "DIRECT";
}
