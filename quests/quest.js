class Quest {
    constructor(data) {
        this.data = data;
    }

    static create(data) {
        return new Quest(data);
    }

    get id() { return this.data.id; }
    get config() { return this.data.config; }
    get userStatus() { return this.data.user_status; }
    get user_status() { return this.data.user_status; }
    get targetedContent() { return this.data.targeted_content; }
    get preview() { return this.data.preview; }
    get traffic_metadata_raw() { return this.data.traffic_metadata_raw; }
    get traffic_metadata_sealed() { return this.data.traffic_metadata_sealed; }

    isExpired(reference = new Date()) {
        return reference.getTime() > new Date(this.data.config.expires_at).getTime();
    }

    isCompleted() {
        return Boolean(this.userStatus?.completed_at);
    }

    isEnrolledQuest() {
        return Boolean(this.userStatus?.enrolled_at);
    }

    hasClaimedRewards() {
        return Boolean(this.userStatus?.claimed_at);
    }

    updateUserStatus(userStatus) {
        this.data.user_status = userStatus;
    }
}

module.exports = { Quest };