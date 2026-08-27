// ABOUTME: Shared remote URL validation for web-test clients and workers.
// ABOUTME: Rejects private, special-use, loopback, and ambiguous IP targets.

export function ipv4Parts(host: string): number[] | null {
	if (!/^(?:\d+\.){3}\d+$/.test(host)) return null;
	const parts = host.split(".").map(Number);
	return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

export function ipv6Parts(host: string): number[] | null {
	let value = host.toLowerCase();
	if (!value.includes(":")) return null;
	if (value.includes(".")) {
		const separator = value.lastIndexOf(":");
		const ipv4 = ipv4Parts(value.slice(separator + 1));
		if (!ipv4) return null;
		value = `${value.slice(0, separator + 1)}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
	}
	const doubleColon = value.indexOf("::");
	if (doubleColon !== value.lastIndexOf("::")) return null;
	const parse = (part: string): number[] => part ? part.split(":").map((word) => /^[0-9a-f]{1,4}$/.test(word) ? Number.parseInt(word, 16) : -1) : [];
	const left = parse(doubleColon < 0 ? value : value.slice(0, doubleColon));
	const right = parse(doubleColon < 0 ? "" : value.slice(doubleColon + 2));
	if ([...left, ...right].some((word) => word < 0)) return null;
	if (doubleColon < 0) return left.length === 8 ? left : null;
	const zeros = 8 - left.length - right.length;
	return zeros > 0 ? [...left, ...Array(zeros).fill(0), ...right] : null;
}

export function isPrivateIpv4(parts: number[]): boolean {
	const [a, b, c] = parts;
	return a === 0 || a === 10 || a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && (b === 0 || b === 168)) ||
		(a === 198 && (b === 18 || b === 19 || b === 51)) ||
		(a === 203 && b === 0 && c === 113) || a >= 224;
}

export function isBlockedHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/[\[\]]/g, "").replace(/\.$/, "");
	const ipv4 = ipv4Parts(host);
	if (ipv4) return isPrivateIpv4(ipv4);
	const ipv6 = ipv6Parts(host);
	if (ipv6) {
		const allZero = ipv6.every((word) => word === 0);
		const loopback = allZero || (ipv6.slice(0, 7).every((word) => word === 0) && ipv6[7] === 1);
		const mapped = ipv6.slice(0, 5).every((word) => word === 0) && ipv6[5] === 0xffff;
		const mappedIpv4 = mapped ? [ipv6[6] >> 8, ipv6[6] & 0xff, ipv6[7] >> 8, ipv6[7] & 0xff] : null;
		return loopback || (mappedIpv4 !== null && isPrivateIpv4(mappedIpv4)) ||
			(ipv6[0] & 0xfe00) === 0xfc00 || (ipv6[0] & 0xffc0) === 0xfe80 || (ipv6[0] & 0xff00) === 0xff00;
	}
	return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
		host.endsWith(".internal") || host.endsWith(".home.arpa") ||
		host === "metadata.google.internal" || host === "instance-data.ec2.internal" ||
		!host.includes(".");
}

export function validatePublicUrl(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Only http: and https: URLs are allowed";
		if (parsed.username || parsed.password) return "URLs with embedded credentials are not allowed";
		return isBlockedHost(parsed.hostname) ? "Local and private network URLs are not allowed" : null;
	} catch {
		return "Invalid URL";
	}
}
