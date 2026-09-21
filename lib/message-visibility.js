function projectMessage(message, canManage) {
  if (!message) return null;
  const stamp = {
    id: message.id,
    ts: message.ts || 0,
    updatedAt: message.updatedAt || message.ts || 0,
  };
  if (message.purged) return { ...stamp, purged: true, hidden: true };
  if (message.deletedByUser && !canManage) return { ...stamp, hidden: true, purged: false };
  return message;
}

function visibleMessages(messages, canManage) {
  return (messages || [])
    .map((message) => projectMessage(message, canManage))
    .filter((message) => message && !message.hidden && !message.purged);
}

module.exports = { projectMessage, visibleMessages };
