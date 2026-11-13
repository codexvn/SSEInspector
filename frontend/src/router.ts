import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'list',
      component: () => import('./views/ListView.vue'),
    },
    {
      path: '/request/:id',
      name: 'detail',
      component: () => import('./views/DetailView.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./views/SettingsView.vue'),
    },
  ],
})

export default router
