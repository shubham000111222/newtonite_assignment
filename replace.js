const fs = require('fs');
let content = fs.readFileSync('api/src/routes/workItems.ts', 'utf8');

content = content.replace(/await client\.query\(\`\s*INSERT INTO events \(work_item_id, team_id, actor_id, type, payload\)\s*VALUES \(\$1, \$2, \$3, \$4, \$5\)\s*\`, (\[.*?\])\);/g, (match, args) => {
  return `const eventRes = await client.query(\`
        INSERT INTO events (work_item_id, team_id, actor_id, type, payload)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
      \`, ${args});
      await client.query(\`
        INSERT INTO jobs (type, event_id, payload) VALUES ('notification', $1, $2)
      \`, [eventRes.rows[0].id, {}]);`;
});

fs.writeFileSync('api/src/routes/workItems.ts', content);
console.log('done');
