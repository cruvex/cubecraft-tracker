// Your input JSON
const data: { timestamp: string, uuid: string, ign: string }[] = [];

const values = data.map((entry) => {
  const id = Bun.randomUUIDv7("hex", new Date(entry.timestamp));

  return `('${id}', '${entry.uuid}', '${entry.ign}')`;
});

const sql = `
INSERT INTO ign_history (id, player_uuid, player_ign)
VALUES
${values.join(",\n")};
`;

console.log(sql);
