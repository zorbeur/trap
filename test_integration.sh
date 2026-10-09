#!/bin/bash
echo "=== Starting Integration Tests ==="

# 1. Start the server in the background
node src/index.js &
SERVER_PID=$!
sleep 2

echo -e "\n=== Test 1: Metrics Endpoint ==="
curl -s http://localhost:3000/metrics | grep timequant_emails_queued_total

echo -e "\n=== Test 2: Send Email (Should Queue) ==="
curl -s -X POST http://localhost:3000/v1/emails/send-templated \
  -H "Authorization: Bearer dev-secret-key" \
  -H "Idempotency-Key: test-key-1" \
  -H "Content-Type: application/json" \
  -d '{
    "to": {"email": "test@example.com"},
    "template_id": "password_reset",
    "template_data": {"user_name": "Test"}
  }'

echo -e "\n\n=== Test 3: Idempotency (Should return same message_id) ==="
curl -s -X POST http://localhost:3000/v1/emails/send-templated \
  -H "Authorization: Bearer dev-secret-key" \
  -H "Idempotency-Key: test-key-1" \
  -H "Content-Type: application/json" \
  -d '{
    "to": {"email": "test@example.com"},
    "template_id": "password_reset",
    "template_data": {"user_name": "Test"}
  }'

echo -e "\n\n=== Test 4: Skip < 6h calculation ==="
curl -s -X POST http://localhost:3000/v1/emails/send-templated \
  -H "Authorization: Bearer dev-secret-key" \
  -H "Idempotency-Key: test-key-2" \
  -H "Content-Type: application/json" \
  -d '{
    "to": {"email": "test2@example.com"},
    "template_id": "simulation_completed",
    "template_data": {"wall_time_s": 5000}
  }'

echo -e "\n\n=== Test 5: Webhook delivery update ==="
curl -s -X POST http://localhost:3000/v1/webhooks/delivery \
  -H "Content-Type: application/json" \
  -d '{"message_id": "msg_custom123", "event": "bounce"}'

echo -e "\n\n=== Test 6: Status check (Webhook Override) ==="
curl -s -H "Authorization: Bearer dev-secret-key" http://localhost:3000/v1/emails/msg_custom123/status

echo -e "\n\n=== Test 7: Rate Limiter (Max 10 per hour) ==="
for i in {1..12}; do
  RES=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/v1/emails/send-templated \
    -H "Authorization: Bearer dev-secret-key" \
    -H "Idempotency-Key: spam-key-$i" \
    -H "Content-Type: application/json" \
    -d "{\"to\": {\"email\": \"spammer@example.com\"}, \"template_id\": \"password_reset\", \"template_data\": {}}")
  echo -n "$RES "
done

echo -e "\n\n=== Test 8: Template API (Admin) ==="
curl -s -u admin:supersecret http://localhost:3000/admin/api/templates/simulation_completed | grep "content" | cut -c 1-50

echo -e "\n\n=== Cleaning up ==="
kill $SERVER_PID
