import { createRouter } from '@nanostores/router';

export const $router = createRouter({
  home: '/',
  demo: '/demo',
});

export type AppPage = NonNullable<ReturnType<typeof $router.get>>;
