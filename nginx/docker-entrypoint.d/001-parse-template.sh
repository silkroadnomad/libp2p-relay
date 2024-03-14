#!/bin/sh
echo 'entry point was ${SERVER_NAME} running' > /tmp/was-running-${SERVER_NAME}.txt
envsubst '${SERVER_NAME}' < /etc/nginx/nginx.conf.template > /etc/nginx/conf.d/${SERVER_NAME}.conf
$data_path=/etc/letsencrypt
mkdir -p "$data_path/conf"
curl -s https://raw.githubusercontent.com/certbot/certbot/master/certbot-nginx/certbot_nginx/tls_configs/options-ssl-nginx.conf > "$data_path/conf/options-ssl-nginx.conf"
curl -s https://raw.githubusercontent.com/certbot/certbot/master/certbot/ssl-dhparams.pem > "$data_path/conf/ssl-dhparams.pem"
echo 'running nginx now and reload every 6 hours'
while :; do sleep 6h & wait ${!}; nginx -s reload; done & nginx -g "daemon off;"

exec "$@"
