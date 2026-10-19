import { defineEventHandler } from 'h3';
import { unifiDeviceRequest } from '~/server/utils/unifi-device.js';
export default defineEventHandler(event => unifiDeviceRequest(event, 'refresh'));
