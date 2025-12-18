import { defineEventHandler } from 'h3'
// import axios from 'axios'
// import * as cheerio from "cheerio";
import Unifi from 'node-unifi'

export default defineEventHandler(async () => {
    try {
        // 🔹 Unifi Controller API
        const unifi = new Unifi.Controller({ host: process.env.UNIFI_HOST, port: 8443, sslverify: false })
        await unifi.login(process.env.UNIFI_USER, process.env.UNIFI_PASS)
        const unifiDevices = await unifi.getAccessDevices("default")
        await unifi.logout()

        // 🔹 Home Assistant API
        //const haRes = await axios.get(`${process.env.HA_URL}/api/states`, {
        //  headers: { Authorization: `Bearer ${process.env.HA_TOKEN}` }
        // })

        // 🔹 Nagios Status Page (HTML)
        /*
        const res = await axios.get(`${process.env.NAGIOS_URL}/cgi-bin/status.cgi?host=all`, {
            auth: {
                username: process.env.NAGIOS_USER,
                password: process.env.NAGIOS_PASS,
            },
        });

        // 🔹 Parse HTML with cheerio
        const $ = cheerio.load(res.data);
        const nagiosdevices = [];
    
        $("table.status > tbody > tr").each((_, el) => {
          const hostCell = $(el).find("td:nth-child(1)"); // Hostname is in the first column
          const serviceCell = $(el).find("td:nth-child(2)"); // Service is in the second column
          const statusCell = $(el).find("td:nth-child(3)"); // Status is in the third column
    
          const hostname = hostCell.text().trim().split(/\s+/)[0]; // Extract only the hostname
          const service = serviceCell.text().trim();
          const status = statusCell.text().trim();
    
          nagiosdevices.push({ host: hostname, service, status });
        });
        */

        return {
             unifi: unifiDevices,
            //  homeAssistant: haRes.data,
            // nagios: nagiosdevices,
            data: {
                u: process.env.UNIFI_HOST,
                h: process.env.HA_URL,
                n: process.env.NAGIOS_URL,
                uu: process.env.UNIFI_USER,
                hu: process.env.HA_USER,
                nu: process.env.NAGIOS_USER,
                up: process.env.UNIFI_PASS,
                hp: process.env.HA_PASS,
                np: process.env.NAGIOS_PASS
            }
        }
    } catch (error) {
        return { error: error.message }
    }
})
