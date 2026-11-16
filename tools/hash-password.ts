const password = process.argv.slice(2).filter(a => a !== "--").join(" ");
if (password.length < 12) throw new Error('Usage: bun run password:hash -- "a-long-unique-password" (min 12 chars)');
console.log(await Bun.password.hash(password, { algorithm: "argon2id" }));
