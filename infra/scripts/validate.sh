#!/bin/bash
for i in $(seq 1 30); do
  curl -fsS http://localhost:3000/api/health && exit 0
  sleep 2
done
exit 1
