<script setup>
const { data, pending, error } = useFetch('/api/devices')
</script>

<template>
  <div class="p-6">
    <h1 class="text-xl font-bold">Network Device Status</h1>

    <div v-if="pending">Loading...</div>
    <div v-if="error" class="text-red-500">Error: {{ error.message }}</div>

    <table v-if="data" class="mt-4 border-collapse border border-gray-300 w-full">
      <thead>
        <tr class="bg-gray-200">
          <th class="border p-2">Device</th>
          <th class="border p-2">IP Address</th>
          <th class="border p-2">Status</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="device in data.unifi" :key="device.mac">
          <td class="border p-2">{{ device.name }}</td>
          <td class="border p-2">{{ device.ip }}</td>
          <td class="border p-2 text-green-600">Online</td>
        </tr>
        <tr v-for="device in data.nagios" :key="device.host_name">
          <td class="border p-2">{{ device.host_name }}</td>
          <td class="border p-2">N/A</td>
          <td class="border p-2" :class="device.status === 'UP' ? 'text-green-600' : 'text-red-600'">
            {{ device.status }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
