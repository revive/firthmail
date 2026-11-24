import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 白屏自愈：React 未捕获的渲染错误会把整棵组件树卸载成白屏。
 * 这里把它接住，把错误原因直接显示在窗口里，配一个重载按钮。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    // devtools 里也能看到
    console.error('FirthMail render crash:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="crash-screen">
          <h1>界面出错了</h1>
          <p>渲染层抛出了异常。下面是原因，发给开发者即可定位：</p>
          <pre>{String(this.state.error.stack ?? this.state.error)}</pre>
          <button onClick={() => window.location.reload()}>重新加载</button>
        </div>
      );
    }
    return this.props.children;
  }
}
