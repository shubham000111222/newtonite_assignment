#!/bin/sh
set -e

echo "Running migrations..."
npm run migrate -- up

echo "Checking if database needs seeding..."
node -e "
const { Client } = require('pg');
const client = new Client({ connectionString: process.env.DATABASE_URL });
async function checkAndSeed() {
  await client.connect();
  const res = await client.query('SELECT COUNT(*) FROM users');
  if (parseInt(res.rows[0].count) === 0) {
    console.log('Database empty. Running seed...');
    require('child_process').execSync('npm run seed', { stdio: 'inherit' });
    console.log('\n==================================================');
    console.log('Seeded login credentials:');
    console.log('Email: user0@example.com (or user1@example.com, etc up to user19)');
    console.log('Password: password123');
    console.log('==================================================\n');
  } else {
    console.log('Database already contains data. Skipping seed.');
  }
  await client.end();
}
checkAndSeed().catch(err => {
  console.error(err);
  process.exit(1);
});
"

echo "=================================================="
echo "Web URL: http://localhost:5173"
echo "=================================================="

echo "Starting API..."
exec npm run dev -w api
