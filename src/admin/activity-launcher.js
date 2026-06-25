export class AdminActivityLauncher {
  constructor({ grantStore, relayClient }) {
    this.grantStore = grantStore;
    this.relayClient = relayClient;
  }

  async launch(interaction, { threadId = null } = {}) {
    if (!this.relayClient?.isReady?.()) {
      throw new Error('관리 relay가 연결되지 않았습니다. 오케스트레이터 로그와 ADMIN_RELAY_* 설정을 확인하세요.');
    }
    const grant = this.grantStore.issue({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      threadId,
    });
    try {
      await interaction.launchActivity();
      return grant;
    } catch (error) {
      this.grantStore.revoke(grant.id);
      throw error;
    }
  }
}
