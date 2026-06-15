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
      props: true,
    },
  ],
})

export default router
